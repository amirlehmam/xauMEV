// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract StubRouter {
    event SwapCalled(address tokenIn, address tokenOut, uint256 amountIn, uint256 balanceIn, uint256 balanceOut);
    event TransferFromFailed(address tokenIn, address from, address to, uint256 amount, string reason);
    event TransferFailed(address tokenOut, address to, uint256 amount, string reason);

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        pure
        returns (uint256[] memory out)
    {
        require(path.length >= 2, "StubRouter: bad path");

        out = new uint256[](2);
        out[0] = amountIn;
        out[1] = amountIn * 2;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256,                // amountOutMin (ignoré)
        address[] calldata path,
        address to,
        uint256                 // deadline (ignoré)
    ) external returns (uint256[] memory out)
    {
        require(path.length >= 2, "StubRouter: bad path");
        
        address tokenIn = path[0];
        address tokenOut = path[path.length - 1];
        
        // Log balances before swap
        uint256 balanceIn = IERC20(tokenIn).balanceOf(address(this));
        uint256 balanceOut = IERC20(tokenOut).balanceOf(address(this));
        emit SwapCalled(tokenIn, tokenOut, amountIn, balanceIn, balanceOut);
        
        // If amountIn is 0, use the entire balance of the token from the sender
        if (amountIn == 0) {
            amountIn = IERC20(tokenIn).balanceOf(msg.sender);
        }
        
        // Transfer tokens from sender to this contract
        try IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn) {
            // Success
        } catch Error(string memory reason) {
            emit TransferFromFailed(tokenIn, msg.sender, address(this), amountIn, reason);
            revert(string(abi.encodePacked("StubRouter: transferFrom failed: ", reason)));
        } catch (bytes memory) {
            emit TransferFromFailed(tokenIn, msg.sender, address(this), amountIn, "unknown error");
            revert("StubRouter: transferFrom failed with no reason");
        }

        // Use a fixed amount for the payout that we know we have
        uint256 payout = 1000000000; // 1000 tokens with 6 decimals
        if (balanceOut < payout) {
            payout = balanceOut; // Use all available balance if less than 1000
        }
        
        // Transfer the output tokens to the recipient
        try IERC20(tokenOut).transfer(to, payout) {
            // Success
        } catch Error(string memory reason) {
            emit TransferFailed(tokenOut, to, payout, reason);
            revert(string(abi.encodePacked("StubRouter: transfer failed: ", reason)));
        } catch (bytes memory) {
            emit TransferFailed(tokenOut, to, payout, "unknown error");
            revert("StubRouter: transfer failed with no reason");
        }

        out = new uint256[](2);
        out[0] = amountIn;
        out[1] = payout;
    }

    receive() external payable {}
    fallback() external payable {}
}
