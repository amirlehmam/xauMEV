// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract StubRouter {
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
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);

        uint256 payout = amountIn * 2;
        IERC20(path[1]).transfer(to, payout);

        out = new uint256[](2);
        out[0] = amountIn;
        out[1] = payout;
    }

    receive() external payable {}
    fallback() external payable {}
}
