// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev A minimal single-leg swap mock. Price = amountIn * num / den
contract SimpleDexMock {
    IERC20 public immutable tokenIn;
    IERC20 public immutable tokenOut;
    uint256 public immutable priceNum;
    uint256 public immutable priceDen;

    constructor(
        address _tokenIn,
        address _tokenOut,
        uint256 _priceNum,
        uint256 _priceDen
    ) {
        tokenIn  = IERC20(_tokenIn);
        tokenOut = IERC20(_tokenOut);
        priceNum = _priceNum;
        priceDen = _priceDen;
    }

    /// @notice swapExactTokensForTokens style: sender must approve this contract
    /// @param amountIn amount of tokenIn to swap
    function swap(uint256 amountIn) external {
        tokenIn.transferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = amountIn * priceNum / priceDen;
        tokenOut.transfer(msg.sender, amountOut);
    }
}
