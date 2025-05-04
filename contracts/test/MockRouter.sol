// SPDX‑License‑Identifier: UNLICENSED
pragma solidity ^0.8.17;

/// @dev Uniswap‑V2‑style router stub — returns amountIn for every hop
contract MockRouter {
    function getAmountsOut(uint amountIn, address[] calldata path)
        external pure returns (uint[] memory amounts)
    {
        amounts = new uint[](path.length);
        for (uint i = 0; i < path.length; ++i) amounts[i] = amountIn;
    }
}
