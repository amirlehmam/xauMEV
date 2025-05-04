// SPDX‑License‑Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev  Tiny mintable ERC‑20 with custom decimals (v4+ pattern)
contract MockERC20 is ERC20 {
    uint8 private immutable _customDecimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _customDecimals = decimals_;
    }

    /// @notice Mint test tokens at will
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev  Override to return the custom decimals value
    function decimals() public view virtual override returns (uint8) {
        return _customDecimals;
    }
}
