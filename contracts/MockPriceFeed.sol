// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

contract MockPriceFeed {
    uint8 public constant decimals = 8;
    int256 private constant WETH_PRICE = 2000 * 1e8;  // 2000 USD for WETH

    function latestRoundData()
        external
        pure
        returns (
            uint80, int256 answer, uint256, uint256, uint80
        )
    {
        return (0, WETH_PRICE, 0, 0, 0);
    }
}
