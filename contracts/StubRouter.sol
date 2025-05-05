// contracts/StubRouter.sol
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title StubRouter
/// @notice Bare-bones test router that always gives 2× the tokens you input.
contract StubRouter {
    /* ---------------------------------------------------------------------- */
    /*  Uniswap-V2-like interface                                             */
    /* ---------------------------------------------------------------------- */

    /// Fake getAmountsOut: returns [amountIn, amountIn * 2]
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        pure
        returns (uint256[] memory out)
    {
        require(path.length >= 2, "StubRouter: bad path");

        out = new uint256;          // <-- array allocation MUST include []
        out[0] = amountIn;
        out[1] = amountIn * 2;
    }

    /// Fake swapExactTokensForTokens:
    /// * pulls `amountIn` of path[0] from caller
    /// * sends `amountIn * 2` of path[1] to `to`
    /// * returns [amountIn, amountIn * 2]
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256,                      // amountOutMin (ignored)
        address[] calldata path,
        address to,
        uint256                       // deadline      (ignored)
    ) external returns (uint256[] memory out) {
        require(path.length >= 2, "StubRouter: bad path");

        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);

        uint256 payout = amountIn * 2;
        IERC20(path[1]).transfer(to, payout);

        out = new uint256;      // <-- same fix here
        out[0] = amountIn;
        out[1] = payout;
    }

    /* ---------------------------------------------------------------------- */
    /*  House-keeping                                                         */
    /* ---------------------------------------------------------------------- */

    receive() external payable {}
    fallback() external payable {}
}
