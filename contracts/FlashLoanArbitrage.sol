// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

// ─── IMPORTS ────────────────────────────────────────────────────────────────
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

// ─── AAVE V3 INTERFACES ─────────────────────────────────────────────────────
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

// ─── UNISWAP V2 ROUTER INTERFACE ────────────────────────────────────────────
interface IUniswapV2Router02 {
    function getAmountsOut(uint256 amountIn, address[] calldata route)
        external
        view
        returns (uint256[] memory amounts);
}

// ─── FLASH LOAN ARBITRAGE ────────────────────────────────────────────────────
/**
 * @title FlashLoanArbitrage
 * @notice Atomically borrows USDT via Aave V3, swaps USDT⇄XAUT on two DEXs, repays, and sends profit to owner.
 */
contract FlashLoanArbitrage is Ownable, ReentrancyGuard, IFlashLoanSimpleReceiver {
    using SafeERC20 for IERC20;

    IPool                public immutable pool;
    IERC20               public immutable USDT;
    IERC20               public immutable XAUT;
    AggregatorV3Interface public immutable priceFeed;
    uint16 public constant REFERRAL_CODE = 0;

    event ArbitrageExecuted(
        uint256 profit,
        address indexed buyRouter,
        address indexed sellRouter
    );

    constructor(
        address _pool,
        address _usdt,
        address _xaut,
        address _priceFeed
    ) {
        require(
            _pool      != address(0) &&
            _usdt      != address(0) &&
            _xaut      != address(0) &&
            _priceFeed != address(0),
            "Zero address"
        );
        pool      = IPool(_pool);
        USDT      = IERC20(_usdt);
        XAUT      = IERC20(_xaut);
        priceFeed = AggregatorV3Interface(_priceFeed);

        // Pre-approve Aave to pull repayments
        USDT.safeApprove(_pool, type(uint256).max);
        XAUT.safeApprove(_pool, type(uint256).max);
    }

    /// @notice Owner-only entrypoint to start a flash-loan arbitrage
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
        bytes memory params = abi.encode(
            buyRouter, buyData,
            sellRouter, sellData,
            minProfit, maxDevBps
        );
        pool.flashLoanSimple(
            address(this),
            address(USDT),
            loanAmount,
            params,
            REFERRAL_CODE
        );
    }

    /// @dev Aave callback: perform swaps, repay+fee, send profit
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(pool), "Caller not pool");
        require(initiator == address(this),    "Not initiated here");
        require(asset     == address(USDT),     "Wrong asset");

        // Decode parameters
        (
            address buyRouter,
            bytes memory buyData,
            address sellRouter,
            bytes memory sellData,
            uint256 minProfit,
            uint256 maxDevBps
        ) = abi.decode(
            params,
            (address, bytes, address, bytes, uint256, uint256)
        );

        // 1) Oracle sanity check
        (, int256 oraclePrice,,,) = priceFeed.latestRoundData();
        require(oraclePrice > 0, "Oracle bad");

        // 2) Build USDT→XAUT route **correctly**
        address;
        route[0] = address(USDT);
        route[1] = address(XAUT);

        // 3) Fetch DEX price vs oracle
        uint256[] memory amountsOut = IUniswapV2Router02(buyRouter)
            .getAmountsOut(1e6 /*1 USDT*/, route);
        require(amountsOut.length == 2, "Price fetch failed");

        uint256 dexPrice = (amountsOut[1] * 1e8) / 1e6;  
        uint256 diffBps = dexPrice > uint256(oraclePrice)
            ? (dexPrice - uint256(oraclePrice)) * 10000 / uint256(oraclePrice)
            : (uint256(oraclePrice) - dexPrice) * 10000 / uint256(oraclePrice);
        require(diffBps <= maxDevBps, "Oracle mismatch");

        // 4) Buy low: USDT → XAUT
        USDT.safeApprove(buyRouter, amount);
        (bool ok1, ) = buyRouter.call(buyData);
        require(ok1, "Buy failed");

        // 5) Sell high: XAUT → USDT
        uint256 xautBal = XAUT.balanceOf(address(this));
        require(xautBal > 0, "No XAUT");
        XAUT.safeApprove(sellRouter, xautBal);
        (bool ok2, ) = sellRouter.call(sellData);
        require(ok2, "Sell failed");

        // 6) Repay + profit
        uint256 finalBal = USDT.balanceOf(address(this));
        uint256 totalDebt = amount + premium;
        require(finalBal >= totalDebt + minProfit, "Insufficient profit");

        USDT.safeApprove(address(pool), totalDebt);
        uint256 profit = finalBal - totalDebt;
        if (profit > 0) {
            USDT.safeTransfer(owner(), profit);
        }

        emit ArbitrageExecuted(profit, buyRouter, sellRouter);
        return true;
    }
}
