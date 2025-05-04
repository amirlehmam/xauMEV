// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

/**
 * @title Aave V3 flash‑loan pool interface (single‑asset)
 */
interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

/**
 * @dev Aave V3 receiver interface (single‑asset)
 */
interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/**
 * @dev Minimal subset of the UniswapV2 router we interact with.
 */
interface IUniswapV2Router02 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/**
 * @notice Flash‑loan powered USDT⇄XAUT arbitrage with oracle sanity checks.
 *
 *         Flow:
 *         1. Owner calls `executeArbitrage`, passing the two router addresses,
 *            calldata for each swap, desired loan size, min profit, and max
 *            allowed deviation (oracle vs AMM price) in basis points.
 *         2. Aave lends USDT → `executeOperation` runs.
 *         3. Contract performs the buy swap (USDT→XAUT) then the sell swap
 *            (XAUT→USDT), repays Aave, checks profit, and transfers it to the
 *            owner.  Entire transaction reverts if anything below thresholds.
 *
 *         Security features:
 *         - `nonReentrant` guard (no external callbacks between swaps).
 *         - Oracle price guard (`maxDevBps`) against manipulated pool pricing.
 *         - Single approval done in constructor (gas‑efficient & safer).
 *         - All state‑changing ops gated to `onlyOwner`.
 */
contract FlashLoanArbitrage is Ownable, ReentrancyGuard, IFlashLoanSimpleReceiver {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    IPool  public immutable pool;         // Aave V3 pool
    IERC20 public immutable USDT;         // 6‑decimals
    IERC20 public immutable XAUT;         // 6‑decimals
    AggregatorV3Interface public immutable priceFeed; // XAU/USD oracle (8‑decimals)

    uint16 public constant REFERRAL_CODE = 0;
    uint256 private constant MAX_BPS = 10_000;

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    event ArbitrageExecuted(
        uint256 indexed profitUSDT,
        address indexed buyRouter,
        address indexed sellRouter
    );

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address _pool,
        address _usdt,
        address _xaut,
        address _priceFeed
    ) {
        require(
            _pool       != address(0) &&
            _usdt       != address(0) &&
            _xaut       != address(0) &&
            _priceFeed  != address(0),
            "Zero address"
        );

        pool      = IPool(_pool);
        USDT      = IERC20(_usdt);
        XAUT      = IERC20(_xaut);
        priceFeed = AggregatorV3Interface(_priceFeed);

        // Unlimited approvals (cheaper single SSTORE, safe because immutable).
        USDT.safeApprove(_pool, type(uint256).max);
        USDT.safeApprove(address(this), type(uint256).max);
        XAUT.safeApprove(address(this), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                         EXTERNAL OWNER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Triggers the flash‑loan & arbitrage.
     *
     * @param buyRouter   Router to convert USDT→XAUT.
     * @param buyData     Pre‑encoded calldata for `swapExactTokensForTokens`.
     * @param sellRouter  Router to convert XAUT→USDT.
     * @param sellData    Pre‑encoded calldata for `swapExactTokensForTokens`.
     * @param loanAmount  USDT amount to borrow.
     * @param minProfit   Minimum net profit denominated in USDT (6 decimals).
     * @param maxDevBps   Max allowed AMM‑to‑oracle deviation, in basis points.
     */
    function executeArbitrage(
        address buyRouter,
        bytes calldata buyData,
        address sellRouter,
        bytes calldata sellData,
        uint256 loanAmount,
        uint256 minProfit,
        uint256 maxDevBps
    ) external onlyOwner nonReentrant {
        require(loanAmount > 0, "Loan zero");
        require(maxDevBps <= MAX_BPS, "Bad dev");
        require(buyRouter != address(0) && sellRouter != address(0), "Router zero");

        bytes memory params = abi.encode(
            buyRouter,
            buyData,
            sellRouter,
            sellData,
            minProfit,
            maxDevBps
        );

        pool.flashLoanSimple(
            address(this),
            address(USDT),
            loanAmount,
            params,
            REFERRAL_CODE
        );
    }

    /**
     * @notice Rescue tokens accidentally sent to the contract.
     */
    function sweep(IERC20 token) external onlyOwner {
        uint256 bal = token.balanceOf(address(this));
        token.safeTransfer(owner(), bal);
    }

    /*//////////////////////////////////////////////////////////////
                         AAVE CALLBACK FUNCTION
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Aave V3 calls this function after lending `amount` USDT.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override nonReentrant returns (bool) {
        /* --------------------------------- */
        /*        Sanity & auth checks       */
        /* --------------------------------- */
        require(
            msg.sender   == address(pool) &&
            initiator    == address(this) &&
            asset        == address(USDT),
            "Unauthorized"
        );

        (
            address buyRouter,
            bytes  memory buyData,
            address sellRouter,
            bytes  memory sellData,
            uint256 minProfit,
            uint256 maxDevBps
        ) = abi.decode(params, (address,bytes,address,bytes,uint256,uint256));

        /* --------------------------------- */
        /*      Oracle price deviation        */
        /* --------------------------------- */
        (, int256 oraclePrice,,,) = priceFeed.latestRoundData();          // 8 decimals
        require(oraclePrice > 0, "Oracle bad");

        // Convert oracle price to USDT's 6‑dec format: 1 XAU in USDT.
        uint256 oraclePrice6 = uint256(oraclePrice) * 1e6 / 1e8;          // 6 decimals

        uint256 preUSDT = USDT.balanceOf(address(this));

        /* --------------------------------- */
        /*          First swap (buy)          */
        /* --------------------------------- */
        // Approve router allowance just‑in‑time (gas optimisation).
        USDT.forceApprove(buyRouter, amount); // OZ 4.9 adds forceApprove

        (bool okBuy, ) = buyRouter.call(buyData);
        require(okBuy, "Buy swap failed");

        uint256 xautBal = XAUT.balanceOf(address(this));
        require(xautBal > 0, "No XAUT");

        /* --------------------------------- */
        /*      Deviation check vs oracle     */
        /* --------------------------------- */
        // Effective price we just paid (USDT per XAUT).
        uint256 ammPrice6 = (amount * 1e6) / xautBal; // 6 decimals

        uint256 dev = _diffBps(ammPrice6, oraclePrice6);
        require(dev <= maxDevBps, "Price dev high");

        /* --------------------------------- */
        /*          Second swap (sell)        */
        /* --------------------------------- */
        XAUT.forceApprove(sellRouter, xautBal);

        (bool okSell, ) = sellRouter.call(sellData);
        require(okSell, "Sell swap failed");

        uint256 finalUSDT = USDT.balanceOf(address(this));
        uint256 profit = finalUSDT > preUSDT + premium
            ? finalUSDT - preUSDT - premium
            : 0;

        require(profit >= minProfit, "Profit lt min");

        /* --------------------------------- */
        /*           Repay & profit           */
        /* --------------------------------- */
        // Transfer profit to owner.
        if (profit > 0) {
            USDT.safeTransfer(owner(), profit);
        }

        // Approve pool to pull owed amount (amount + premium).
        uint256 repayment = amount + premium;
        USDT.forceApprove(address(pool), repayment);

        emit ArbitrageExecuted(profit, buyRouter, sellRouter);
        return true;
    }

    /*//////////////////////////////////////////////////////////////
                         INTERNAL PURE HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Absolute difference in basis points between two uint256 numbers.
     */
    function _diffBps(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 diff = a > b ? a - b : b - a;
        return diff * MAX_BPS / b;
    }
}
