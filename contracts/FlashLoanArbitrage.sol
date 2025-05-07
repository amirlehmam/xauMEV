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
            "unauth: sender or initiator or asset mismatch"
        );

        (
            address buyRouter,
            bytes   memory buyData,
            address sellRouter,
            bytes   memory sellData,
            uint256 minProfit,
            uint256 maxDevBps
        ) = abi.decode(params, (address, bytes, address, bytes, uint256, uint256));

        uint256 profit = 0;

        /*───────── 1. Oracle price ─────────*/
        try priceFeed.latestRoundData() returns (uint80, int256 oracle, uint256, uint256, uint80) {
            require(oracle > 0, "oracle price <= 0");
            uint256 oraclePrice6 = uint256(oracle) * 1e6 / 1e8;

            /*───────── 2. Balances avant swap ──*/
            uint256 balBefore = USDT.balanceOf(address(this));

            /*───────── 3. USDT → XAUT ──────────*/
            USDT.forceApprove(buyRouter, amount);
            (bool okBuy, bytes memory buyResult) = buyRouter.call(buyData);
            if (!okBuy) {
                string memory reason = _getRevertMsg(buyResult);
                revert(string(abi.encodePacked("buy fail: ", reason)));
            }

            uint256 xautBal = XAUT.balanceOf(address(this));
            require(xautBal > 0, "no XAUT received after swap");

            /* Price deviation guard */
            uint256 ammPrice6 = (amount * 1e6) / xautBal;
            uint256 deviation = _diffBps(ammPrice6, oraclePrice6);
            require(deviation <= maxDevBps, string(abi.encodePacked("deviation too big: ", _uintToString(deviation), " > ", _uintToString(maxDevBps))));

            /*───────── 4. XAUT → USDT ──────────*/
            XAUT.forceApprove(sellRouter, xautBal);
            (bool okSell, bytes memory sellResult) = sellRouter.call(sellData);
            if (!okSell) {
                string memory reason = _getRevertMsg(sellResult);
                revert(string(abi.encodePacked("sell fail: ", reason)));
            }

            /*───────── 5. Profit ───────────────*/
            uint256 balAfter = USDT.balanceOf(address(this));
            if (balAfter > balBefore + premium) {
                profit = balAfter - balBefore - premium;
            }
            require(profit >= minProfit, string(abi.encodePacked("profit < min: ", _uintToString(profit), " < ", _uintToString(minProfit))));
            
            if (profit > 0) USDT.safeTransfer(owner(), profit);

            /*───────── 6. Repayment ────────────*/
            USDT.forceApprove(address(pool), amount + premium);
        } catch Error(string memory reason) {
            revert(string(abi.encodePacked("oracle error: ", reason)));
        } catch (bytes memory) {
            revert("oracle call failed");
        }

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

    function _getRevertMsg(bytes memory _returnData) internal pure returns (string memory) {
        // If the _res length is less than 68, then the transaction failed silently (without a revert message)
        if (_returnData.length < 68) return "Transaction reverted silently";
        
        assembly {
            // Slice the sighash.
            _returnData := add(_returnData, 0x04)
        }
        return abi.decode(_returnData, (string));
    }
    
    function _uintToString(uint256 value) internal pure returns (string memory) {
        // Special case for 0
        if (value == 0) {
            return "0";
        }
        
        // Find the length of the number
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        
        // Create a byte array with the correct length
        bytes memory buffer = new bytes(digits);
        
        // Fill the buffer from right to left
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        
        return string(buffer);
    }
}
