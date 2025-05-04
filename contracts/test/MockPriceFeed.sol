// SPDX‑License‑Identifier: UNLICENSED
pragma solidity ^0.8.17;

contract MockPriceFeed {
    function latestRoundData()
        external pure
        returns (uint80,int256,uint256,uint256,uint80)
    {
        return (0, 1e8, 0, 0, 0);
    }
}
