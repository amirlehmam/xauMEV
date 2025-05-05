// contracts/MockProfitRouter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Dummy router paying out 2× the input, matching Uniswap V2’s interface.
contract MockProfitRouter {
    /// @dev getAmountsOut must return uint256[] memory of length 2.
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        pure
        returns (uint256[] memory)
    {
        require(path.length >= 2, "bad path");
        // Allocate a dynamic array of length 2
        uint256;
        result[0] = amountIn;
        result[1] = amountIn * 2;
        return result;
    }

    /// @dev swapExactTokensForTokens returns the same dynamic array.
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256,                // amountOutMin ignored
        address[] calldata path,
        address to,
        uint256                 // deadline ignored
    ) external returns (uint256[] memory)
    {
        require(path.length >= 2, "bad path");
        // Pull in input tokens
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        // Compute double payout
        uint256 payout = amountIn * 2;
        IERC20(path[1]).transfer(to, payout);

        // Allocate & return the result array
        uint256;
        result[0] = amountIn;
        result[1] = payout;
        return result;
    }
}
