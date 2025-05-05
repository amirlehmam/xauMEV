// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

/*──────────────────────────────────────────────────────────────
 *                         Aave V3 interfaces
 *────────────────────────────────────────────────────────────*/
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

/*──────────────────────────────────────────────────────────────
 *                        Uniswap V3 router
 *────────────────────────────────────────────────────────────*/
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
    function exactInputSingle(ExactInputSingleParams calldata)
        external payable returns (uint256);
}

/**
 * @title FlashLoanArbitrage
 * @notice Exécute un flash-loan Aave V3 + deux swaps Uniswap V3
 */
contract FlashLoanArbitrage is Ownable, ReentrancyGuard, IFlashLoanSimpleReceiver {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                            IMMUTABLES
    //////////////////////////////////////////////////////////////*/
    IPool   public immutable pool;
    IERC20  public immutable USDT;    // 6 dec
    IERC20  public immutable XAUT;    // 6 dec
    AggregatorV3Interface public immutable priceFeed; // XAU/USD 8 dec

    uint16  public constant REFERRAL_CODE = 0;
    uint256 private constant MAX_BPS      = 10_000;   // 100 %

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
        require(
            _pool != address(0) &&
            _usdt != address(0) &&
            _xaut != address(0) &&
            _priceFeed != address(0),
            "zero addr"
        );
        pool      = IPool(_pool);
        USDT      = IERC20(_usdt);
        XAUT      = IERC20(_xaut);
        priceFeed = AggregatorV3Interface(_priceFeed);

        USDT.safeApprove(_pool, type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                         EXTERNAL OWNER ACTION
    //////////////////////////////////////////////////////////////*/
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
        require(maxDevBps <= MAX_BPS, "dev>100%");

        bytes memory p = abi.encode(
            buyRouter, buyData,
            sellRouter, sellData,
            minProfit,  maxDevBps
        );
        pool.flashLoanSimple(address(this), address(USDT), loanAmount, p, REFERRAL_CODE);
    }

    /*//////////////////////////////////////////////////////////////
                     AAVE FLASH-LOAN CALLBACK
    //////////////////////////////////////////////////////////////*/
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(
            msg.sender == address(pool) &&
            initiator  == address(this) &&
            asset      == address(USDT),
            "unauth"
        );

        (
            address buyRouter,
            bytes   memory buyData,
            address sellRouter,
            bytes   memory sellData,
            uint256 minProfit,
            uint256 maxDevBps
        ) = abi.decode(params, (address, bytes, address, bytes, uint256, uint256));

        /*───────── 1. Oracle price ─────────*/
        (, int256 oracle,,,) = priceFeed.latestRoundData();
        require(oracle > 0, "oracle bad");
        uint256 oraclePrice6 = uint256(oracle) * 1e6 / 1e8;

        /*───────── 2. Balances avant swap ──*/
        uint256 balBefore = USDT.balanceOf(address(this));

        /*───────── 3. USDT → XAUT ──────────*/
        USDT.forceApprove(buyRouter, amount);
        (bool okBuy, ) = buyRouter.call(buyData);
        require(okBuy, "buy fail");

        uint256 xautBal = XAUT.balanceOf(address(this));
        require(xautBal > 0, "no XAUT");

        /* Price deviation guard */
        uint256 ammPrice6 = (amount * 1e6) / xautBal;
        require(_diffBps(ammPrice6, oraclePrice6) <= maxDevBps, "dev too big");

        /*───────── 4. XAUT → USDT ──────────*/
        XAUT.forceApprove(sellRouter, xautBal);
        (bool okSell, ) = sellRouter.call(sellData);
        require(okSell, "sell fail");

        /*───────── 5. Profit ───────────────*/
        uint256 balAfter = USDT.balanceOf(address(this));
        uint256 profit   = balAfter > balBefore + premium ? balAfter - balBefore - premium : 0;
        require(profit >= minProfit, "profit<min");
        if (profit > 0) USDT.safeTransfer(owner(), profit);

        /*───────── 6. Repayment ────────────*/
        USDT.forceApprove(address(pool), amount + premium);

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
