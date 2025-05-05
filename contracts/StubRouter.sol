// contracts/StubRouter.sol
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title StubRouter
/// @notice A bare-bones *Uniswap-V2-compatible* router used **only** in tests.
///         It pretends every trade gives you **2×** the tokens you put in, so
///         the flash-loan contract can realise a deterministic profit.
contract StubRouter {
    /* ---------------------------------------------------------------------- */
    /*  Uniswap-V2 Router public interface                                    */
    /* ---------------------------------------------------------------------- */

    /// Mimics `getAmountsOut()` but simply returns `{amountIn, amountIn * 2}`.
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        pure
        returns (uint256[] memory out)
    {
        require(path.length >= 2, "StubRouter: bad path");

        out = new uint256;
        out[0] = amountIn;
        out[1] = amountIn * 2;
    }

    /// Mimics `swapExactTokensForTokens()`:
    ///  * pulls `amountIn` of `path[0]` from the caller
    ///  * sends `amountIn * 2` of `path[1]` to `to`
    ///  * returns `{amountIn, amountIn * 2}`
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256,                      // amountOutMin (ignored)
        address[] calldata path,
        address to,
        uint256                       // deadline      (ignored)
    ) external returns (uint256[] memory out) {
        require(path.length >= 2, "StubRouter: bad path");

        // Pull the input tokens from msg.sender
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);

        uint256 payout = amountIn * 2;

        // Pay the “profit” out to `to`
        IERC20(path[1]).transfer(to, payout);

        out = new uint256;
        out[0] = amountIn;
        out[1] = payout;
    }

    /* ---------------------------------------------------------------------- */
    /*  House-keeping                                                         */
    /* ---------------------------------------------------------------------- */

    /// Accept ETH just in case a test sends it.
    receive() external payable {}
    fallback() external payable {}
}
