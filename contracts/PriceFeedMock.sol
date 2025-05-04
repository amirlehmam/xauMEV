// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

/// @dev Simple Chainlink price feed mock returning a fixed price
contract PriceFeedMock is AggregatorV3Interface {
    int256 private _price;
    constructor(int256 initialPrice) {
        _price = initialPrice;
    }

    function latestRoundData()
        external
        view
        override
        returns (
            uint80, int256 answer, uint256, uint256, uint80
        )
    {
        return (0, _price, 0, 0, 0);
    }

    // Unused interface funcs
    function decimals() external pure override returns (uint8) { return 8; }
    function description() external pure override returns (string memory) { return "Mock"; }
    function version() external pure override returns (uint256) { return 0; }
    function getRoundData(uint80)
        external
        pure
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        revert("Not implemented");
    }
}
