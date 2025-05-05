// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

contract MockPriceFeed {
    uint8 public constant decimals = 8;
    int256 private constant ONE = 1e8;  // 1 USD

    function latestRoundData()
        external
        pure
        returns (
            uint80, int256 answer, uint256, uint256, uint80
        )
    {
        return (0, ONE, 0, 0, 0);
    }
}
