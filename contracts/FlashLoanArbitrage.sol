// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

// ─── EXTERNAL INTERFACES ─────────────────────────────────────────────────────

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

/// @dev Minimal Aave V3 Pool & Receiver interfaces
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

// ─── CONTRACT ────────────────────────────────────────────────────────────────

/**
 * @title FlashLoanArbitrage
 * @notice Atomic XAUT/USDT arbitrage via Aave V3 flash loans and two DEX swaps
 */
contract FlashLoanArbitrage is Ownable, ReentrancyGuard, IFlashLoanSimpleReceiver {
    using SafeERC20 for IERC20;

    IPool public immutable pool;                // Aave V3 Pool
    IERC20 public immutable USDT;               // USDT token
    IERC20 public immutable XAUT;               // Tether Gold token
    AggregatorV3Interface public immutable priceFeed; // Chainlink XAU/USD

    uint16 public constant REFERRAL_CODE = 0;

    event ArbitrageExecuted(
      uint256 profit,
      address buyRouter,
      address sellRouter
    );

    constructor(
      address _pool,
      address _usdt,
      address _xaut,
      address _priceFeed
    ) {
      require(_pool != address(0) &&
              _usdt != address(0) &&
              _xaut != address(0) &&
              _priceFeed != address(0),
              "Zero address");
      pool       = IPool(_pool);
      USDT       = IERC20(_usdt);
      XAUT       = IERC20(_xaut);
      priceFeed  = AggregatorV3Interface(_priceFeed);

      // Approve pool to pull repayment
      USDT.safeApprove(address(pool), type(uint256).max);
      XAUT.safeApprove(address(pool), type(uint256).max);
    }

    /**
     * @notice Owner-only entrypoint to start the flash loan arbitrage
     * @param buyRouter         DEX router where USDT→XAUT (buy low)
     * @param buyData           calldata for buyRouter.swapExactTokensForTokens(...)
     * @param sellRouter        DEX router where XAUT→USDT (sell high)
     * @param sellData          calldata for sellRouter.swapExactTokensForTokens(...)
     * @param loanAmount        amount of USDT to borrow
     * @param minProfit         minimum USDT profit required (to guard slippage)
     * @param maxDevBps         max oracle deviation in basis points (e.g. 50 = 0.5%)
     */
    function executeArbitrage(
      address buyRouter,
      bytes calldata buyData,
      address sellRouter,
      bytes calldata sellData,
      uint256 loanAmount,
      uint256 minProfit,
      uint256 maxDevBps
    )
      external
      onlyOwner
      nonReentrant
    {
      require(loanAmount > 0, "Loan > 0");
      // package params for use in callback
      bytes memory params = abi.encode(
        buyRouter,
        buyData,
        sellRouter,
        sellData,
        minProfit,
        maxDevBps
      );
      // initiate flash loan
      pool.flashLoanSimple(
        address(this),
        address(USDT),
        loanAmount,
        params,
        REFERRAL_CODE
      );
    }

    /**
     * @dev Aave callback. We receive `amount` USDT here, perform two swaps, repay + fee
     */
    function executeOperation(
      address asset,
      uint256 amount,
      uint256 premium,
      address initiator,
      bytes calldata params
    )
      external
      override
      returns (bool)
    {
      require(msg.sender == address(pool), "Caller not pool");
      require(initiator == address(this), "Not initiated by this contract");
      require(asset == address(USDT), "Unrecognized asset");

      // decode parameters
      (
        address buyRouter,
        bytes memory buyData,
        address sellRouter,
        bytes memory sellData,
        uint256 minProfit,
        uint256 maxDevBps
      ) = abi.decode(params, (address, bytes, address, bytes, uint256, uint256));

      // 1) Oracle check: ensure Chainlink price vs DEX price deviation ≤ maxDevBps
      (, int256 oraclePrice,,,) = priceFeed.latestRoundData(); // e.g. 1850 × 1e8
      require(oraclePrice > 0, "Bad oracle");
      // get DEX mid-price via on-chain call to router.getAmountsOut
      uint;
      path[0] = uint(uint160(address(USDT)));
      path[1] = uint(uint160(address(XAUT)));
      uint[] memory amountsOut = IERC20(buyRouter)
        .staticcall(
          abi.encodeWithSignature(
            "getAmountsOut(uint256,address[])",
            1e6, // 1 USDT (6 decimals)
            _toAddressArray(path)
          )
        ).length > 0
        ? abi.decode(
            IERC20(buyRouter)
              .staticcall(
                abi.encodeWithSignature(
                  "getAmountsOut(uint256,address[])",
                  1e6,
                  _toAddressArray(path)
                )
              ),
            (uint[])
          )
        : new uint;
      require(amountsOut.length == 2, "DEX price fetch failed");
      // DEX price: XAUT per USDT = amountsOut[1] / 1e6, to compare with oraclePrice/1e8
      uint256 dexPrice = (amountsOut[1] * 1e8) / 1e6;
      // deviation = |dexPrice − oraclePrice| / oraclePrice
      uint256 deviationBps = dexPrice > uint256(oraclePrice)
        ? (dexPrice - uint256(oraclePrice)) * 10_000 / uint256(oraclePrice)
        : (uint256(oraclePrice) - dexPrice) * 10_000 / uint256(oraclePrice);
      require(deviationBps <= maxDevBps, "Oracle mismatch");

      // 2) Perform buy‐low swap: USDT -> XAUT
      USDT.safeApprove(buyRouter, amount);
      (bool ok1, ) = buyRouter.call(buyData);
      require(ok1, "Buy swap failed");

      // 3) Perform sell‐high swap: XAUT -> USDT
      uint256 xautBal = XAUT.balanceOf(address(this));
      require(xautBal > 0, "No XAUT acquired");
      XAUT.safeApprove(sellRouter, xautBal);
      (bool ok2, ) = sellRouter.call(sellData);
      require(ok2, "Sell swap failed");

      // 4) Compute final USDT balance & ensure profit
      uint256 finalBal = USDT.balanceOf(address(this));
      uint256 totalDebt = amount + premium;
      require(finalBal >= totalDebt + minProfit, "Insufficient profit");

      // 5) Approve pool repayment & send profit to owner
      USDT.safeApprove(address(pool), totalDebt);
      uint256 profit = finalBal - totalDebt;
      if (profit > 0) {
        USDT.safeTransfer(owner(), profit);
      }

      emit ArbitrageExecuted(profit, buyRouter, sellRouter);
      return true;
    }

    /// @dev utility to convert uint[] (addresses as uint) → address[]
    function _toAddressArray(uint[] memory a) internal pure returns (address[] memory) {
      address[] memory arr = new address[](a.length);
      for (uint i = 0; i < a.length; i++) {
        arr[i] = address(uint160(a[i]));
      }
      return arr;
    }
}
