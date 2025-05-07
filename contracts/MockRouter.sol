// SPDX‑License‑Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockRouter {
    event SwapCalled(address tokenIn, address tokenOut, uint256 amountIn);
    event ExactInputSingleCalled(address tokenIn, address tokenOut, uint256 amountIn);
    event FallbackCalled(bytes data);

    function getAmountsOut(uint amountIn, address[] calldata path)
        external pure returns (uint[] memory amounts)
    {
        amounts = new uint[](path.length);
        for (uint i = 0; i < path.length; ++i) amounts[i] = amountIn;
    }

    // Implement swapExactTokensForTokens to actually swap tokens
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256,                // amountOutMin (ignored)
        address[] calldata path,
        address to,
        uint256                 // deadline (ignored)
    ) external returns (uint256[] memory out)
    {
        require(path.length >= 2, "MockRouter: bad path");
        
        emit SwapCalled(path[0], path[path.length - 1], amountIn);
        
        // If amountIn is 0, use the entire balance of the token
        if (amountIn == 0) {
            amountIn = IERC20(path[0]).balanceOf(msg.sender);
        }
        
        // Transfer tokens from sender to this contract
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);

        // Transfer the same amount of output tokens to the recipient
        // In a real router, this would be a different amount based on the exchange rate
        IERC20(path[path.length - 1]).transfer(to, amountIn);

        // Return the amounts
        out = new uint256[](path.length);
        for (uint i = 0; i < path.length; ++i) {
            out[i] = amountIn;
        }
    }

    // Implement exactInputSingle for Uniswap V3 style calls
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256) {
        emit ExactInputSingleCalled(params.tokenIn, params.tokenOut, params.amountIn);
        
        // If amountIn is 0, use the entire balance of the token
        uint256 amountIn = params.amountIn;
        if (amountIn == 0) {
            amountIn = IERC20(params.tokenIn).balanceOf(msg.sender);
        }
        
        // Transfer tokens from sender to this contract
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), amountIn);

        // Transfer the same amount of output tokens to the recipient
        IERC20(params.tokenOut).transfer(params.recipient, amountIn);

        return amountIn;
    }

    /* Accept any other call data and succeed */
    fallback() external payable {
        emit FallbackCalled(msg.data);
    }
    receive() external payable {}
}
