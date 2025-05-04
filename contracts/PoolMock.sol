// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./FlashLoanArbitrage.sol";

/// @dev Simulates Aave V3 flashLoanSimple with a fixed fee
contract PoolMock {
    IERC20 public immutable usdt;

    constructor(address _usdt) {
        usdt = IERC20(_usdt);
    }

    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        // Transfer loan
        usdt.transfer(receiver, amount);
        // Call back
        uint256 premium = (amount * 9) / 10000; // 0.09% fee
        FlashLoanArbitrage(receiver).executeOperation(
            asset,
            amount,
            premium,
            address(this),
            params
        );
        // At end, this mock does not pull repayment (contract under test already approved usdt)
    }
}
