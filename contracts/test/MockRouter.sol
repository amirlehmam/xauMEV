// SPDX‑License‑Identifier: UNLICENSED
pragma solidity ^0.8.17;

/// @dev 1) Uniswap‑V2‑style router stub — returns path‑length array with amountIn in each slot
contract MockRouter {
    function getAmountsOut(uint amountIn, address[] calldata path)
        external pure returns (uint[] memory amounts)
    {
        amounts = new uint[](path.length);
        for (uint i = 0; i < path.length; ++i) amounts[i] = amountIn;
    }
}

// SPDX‑License‑Identifier: UNLICENSED
pragma solidity ^0.8.17;

/// @dev 2) Chainlink PriceFeed stub — always returns price = 1e8
contract MockPriceFeed {
    function latestRoundData()
        external pure
        returns (uint80,int256,uint256,uint256,uint80)
    {
        return (0, 1e8, 0, 0, 0);
    }
}
