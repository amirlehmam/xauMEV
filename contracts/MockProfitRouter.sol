// contracts/MockProfitRouter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockProfitRouter {
    /// @notice Returns [amountIn, amountIn * 2]
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        pure
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "bad path");
        // Correct dynamic-array allocation:
        amounts = new uint256;
        amounts[0] = amountIn;
        amounts[1] = amountIn * 2;
    }

    /// @notice swapExactTokensForTokens: takes your tokens, sends back 2× amount
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256,                // amountOutMin (ignored)
        address[] calldata path,
        address to,
        uint256                // deadline (ignored)
    ) external returns (uint256[] memory amounts) {
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 outAmount = amountIn * 2;
        IERC20(path[1]).transfer(to, outAmount);

        amounts = new uint256;
        amounts[0] = amountIn;
        amounts[1] = outAmount;
    }
}
