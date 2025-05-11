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
    AggregatorV3Interface public immutable priceFeed;
    uint16  public constant REFERRAL_CODE = 0;
    uint256 private constant MAX_BPS      = 10_000;   // 100 %

    /*//////////////////////////////////////////////////////////////
                               EVENTS
    //////////////////////////////////////////////////////////////*/
    event ArbitrageExecuted(uint256 profit, address buyRouter, address sellRouter, address baseToken, address targetToken);

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/
    constructor(
        address _pool,
        address _priceFeed
    ) {
        require(
            _pool != address(0) &&
            _priceFeed != address(0),
            "zero addr"
        );
        pool      = IPool(_pool);
        priceFeed = AggregatorV3Interface(_priceFeed);
    }

    /*//////////////////////////////////////////////////////////////
                         EXTERNAL OWNER ACTION
    //////////////////////////////////////////////////////////////*/
    function executeArbitrage(
        address buyRouter,
        bytes calldata buyData,
        address sellRouter,
        bytes calldata sellData,
        address baseToken,   // e.g., USDT
        address targetToken, // e.g., any from tokens.json
        uint256 loanAmount,
        uint256 minProfit,
        uint256 maxDevBps
    ) external onlyOwner nonReentrant {
        require(loanAmount > 0, "loan=0");
        require(maxDevBps <= MAX_BPS, "dev>100%");
        require(baseToken != address(0) && targetToken != address(0), "zero token addr");

        struct ArbParams {
            address buyRouter;
            bytes buyData;
            address sellRouter;
            bytes sellData;
            address baseToken;
            address targetToken;
            uint256 minProfit;
            uint256 maxDevBps;
        }

        ArbParams memory arbParams = ArbParams({
            buyRouter: buyRouter,
            buyData: buyData,
            sellRouter: sellRouter,
            sellData: sellData,
            baseToken: baseToken,
            targetToken: targetToken,
            minProfit: minProfit,
            maxDevBps: maxDevBps
        });
        bytes memory p = abi.encode(arbParams);
        pool.flashLoanSimple(address(this), baseToken, loanAmount, p, REFERRAL_CODE);
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
        struct ArbParams {
            address buyRouter;
            bytes buyData;
            address sellRouter;
            bytes sellData;
            address baseToken;
            address targetToken;
            uint256 minProfit;
            uint256 maxDevBps;
        }

        ArbParams memory arb = abi.decode(params, (ArbParams));
        require(
            msg.sender == address(pool) &&
            initiator  == address(this) &&
            asset      == arb.baseToken,
            "unauth: sender or initiator or asset mismatch"
        );

        uint256 profit = 0;
        IERC20 base = IERC20(arb.baseToken);
        IERC20 target = IERC20(arb.targetToken);

        try priceFeed.latestRoundData() returns (uint80, int256 oracle, uint256, uint256, uint80) {
            require(oracle > 0, "oracle price <= 0");
            uint256 oraclePrice6 = uint256(oracle) * 1e6 / 1e8;

            uint256 balBefore = base.balanceOf(address(this));

            base.forceApprove(arb.buyRouter, amount);
            (bool okBuy, bytes memory buyResult) = arb.buyRouter.call(arb.buyData);
            if (!okBuy) {
                string memory reason = _getRevertMsg(buyResult);
                revert(string(abi.encodePacked("buy fail: ", reason)));
            }

            uint256 targetBal = target.balanceOf(address(this));
            require(targetBal > 0, "no target received after swap");

            uint256 ammPrice6 = (amount * 1e6) / targetBal;
            uint256 deviation = _diffBps(ammPrice6, oraclePrice6);
            require(deviation <= arb.maxDevBps, string(abi.encodePacked("deviation too big: ", _uintToString(deviation), " > ", _uintToString(arb.maxDevBps))));

            target.forceApprove(arb.sellRouter, targetBal);
            (bool okSell, bytes memory sellResult) = arb.sellRouter.call(arb.sellData);
            if (!okSell) {
                string memory reason = _getRevertMsg(sellResult);
                revert(string(abi.encodePacked("sell fail: ", reason)));
            }

            uint256 balAfter = base.balanceOf(address(this));
            if (balAfter > balBefore + premium) {
                profit = balAfter - balBefore - premium;
            }
            require(profit >= arb.minProfit, string(abi.encodePacked("profit < min: ", _uintToString(profit), " < ", _uintToString(arb.minProfit))));
            if (profit > 0) base.safeTransfer(owner(), profit);
            base.forceApprove(address(pool), amount + premium);
        } catch Error(string memory reason) {
            revert(string(abi.encodePacked("oracle error: ", reason)));
        } catch (bytes memory) {
            revert("oracle call failed");
        }

        emit ArbitrageExecuted(profit, arb.buyRouter, arb.sellRouter, arb.baseToken, arb.targetToken);
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
