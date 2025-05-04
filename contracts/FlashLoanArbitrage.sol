// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/// @dev Minimal subset of Uniswap V3 router we need
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/**
 * @title FlashLoanArbitrage
 * @notice Aave V3 flash‑loan receiver executing single‑hop USDT⇄XAUT arbitrage
 *         with Chainlink price‑deviation guard and profit extraction.
 */
contract FlashLoanArbitrage is Ownable, ReentrancyGuard, IFlashLoanSimpleReceiver {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                IMMUTABLES
    //////////////////////////////////////////////////////////////*/
    IPool  public immutable pool;
    IERC20 public immutable USDT; // 6 dec
    IERC20 public immutable XAUT; // 6 dec
    AggregatorV3Interface public immutable priceFeed; // XAU/USD 8 dec

    uint16 public constant REFERRAL_CODE = 0;
    uint256 private constant MAX_BPS = 10_000;

    /*//////////////////////////////////////////////////////////////
                                   EVENTS
    //////////////////////////////////////////////////////////////*/
    event ArbitrageExecuted(uint256 profitUSDT, address buyRouter, address sellRouter);

    /*//////////////////////////////////////////////////////////////
                                CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/
    constructor(
        address _pool,
        address _usdt,
        address _xaut,
        address _priceFeed
    ) {
        require(_pool != address(0) && _usdt != address(0) && _xaut != address(0) && _priceFeed != address(0), "Zero addr");
        pool = IPool(_pool);
        USDT = IERC20(_usdt);
        XAUT = IERC20(_xaut);
        priceFeed = AggregatorV3Interface(_priceFeed);

        USDT.safeApprove(_pool, type(uint256).max);
        USDT.safeApprove(address(this), type(uint256).max);
        XAUT.safeApprove(address(this), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                         EXTERNAL OWNER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Entry‑point: triggers a USDT flash‑loan and executes the two swaps.
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
        require(loanAmount > 0, "loan=0");
        require(maxDevBps <= MAX_BPS, "dev too high");

        bytes memory params = abi.encode(
            buyRouter,
            buyData,
            sellRouter,
            sellData,
            minProfit,
            maxDevBps
        );

        pool.flashLoanSimple(address(this), address(USDT), loanAmount, params, REFERRAL_CODE);
    }

    /**
     * @notice Rescue tokens sent by mistake.
     */
    function sweep(IERC20 token) external onlyOwner {
        token.safeTransfer(owner(), token.balanceOf(address(this)));
    }

    /*//////////////////////////////////////////////////////////////
                     AAVE FLASH‑LOAN CALLBACK (no guard!)
    //////////////////////////////////////////////////////////////*/
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(pool) && initiator == address(this) && asset == address(USDT), "unauth");

        (
            address buyRouter,
            bytes memory buyData,
            address sellRouter,
            bytes memory sellData,
            uint256 minProfit,
            uint256 maxDevBps
        ) = abi.decode(params, (address, bytes, address, bytes, uint256, uint256));

        // ---------------- Oracle price ----------------
        (, int256 oraclePrice,,,) = priceFeed.latestRoundData();
        require(oraclePrice > 0, "oracle bad");
        uint256 oraclePrice6 = uint256(oraclePrice) * 1e6 / 1e8;

        uint256 balanceBefore = USDT.balanceOf(address(this));

        // ---------------- First swap (USDT→XAUT) ----------------
        USDT.forceApprove(buyRouter, amount);
        (bool okBuy,) = buyRouter.call(buyData);
        require(okBuy, "buy swap fail");

        uint256 xautBal = XAUT.balanceOf(address(this));
        require(xautBal > 0, "no XAUT");

        // Price deviation check
        uint256 ammPrice6 = (amount * 1e6) / xautBal; // USDT per XAUT in 6 dec
        require(_diffBps(ammPrice6, oraclePrice6) <= maxDevBps, "dev too high");

        // ---------------- Second swap (XAUT→USDT) ----------------
        XAUT.forceApprove(sellRouter, xautBal);
        (bool okSell,) = sellRouter.call(sellData);
        require(okSell, "sell swap fail");

        uint256 balanceAfter = USDT.balanceOf(address(this));
        uint256 profit = balanceAfter > balanceBefore + premium ? balanceAfter - balanceBefore - premium : 0;
        require(profit >= minProfit, "profit<min");

        // Transfer profit
        if (profit > 0) USDT.safeTransfer(owner(), profit);

        // Repay loan
        uint256 repayment = amount + premium;
        USDT.forceApprove(address(pool), repayment);

        emit ArbitrageExecuted(profit, buyRouter, sellRouter);
        return true;
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/
    function _diffBps(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 diff = a > b ? a - b : b - a;
        return diff * MAX_BPS / b;
    }
}
