// SPDX‑License‑Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/// @dev  25‑line flash‑loan stub for local tests
contract MockPool {
    uint16  public constant REFERRAL_CODE = 0;
    uint256 public constant FEE_BPS       = 9;   // 0.09 %

    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16   /* referralCode (ignored) */
    ) external {
        IERC20 token = IERC20(asset);

        // lend
        token.transfer(receiver, amount);

        // fee
        uint256 fee = (amount * FEE_BPS) / 10_000;

        // callback
        require(
            IFlashLoanSimpleReceiver(receiver).executeOperation(
                asset, amount, fee, address(this), params
            ),
            "callback failed"
        );

        // repayment
        token.transferFrom(receiver, address(this), amount + fee);
    }
}
