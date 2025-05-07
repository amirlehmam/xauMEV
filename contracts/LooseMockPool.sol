// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./FlashLoanArbitrage.sol";   // interface IFlashLoanSimpleReceiver

/**
 * @dev  Stub Aave-V3 Pool : ne vérifie rien, ne prélève aucun premium.
 *       Assez pour les tests locaux ; à ne JAMAIS utiliser en production !
 */
contract LooseMockPool {
    event FlashLoanInitiated(address receiver, address asset, uint256 amount);
    event FlashLoanCallbackCalled(address receiver, address asset, uint256 amount);
    event FlashLoanRepaid(address receiver, address asset, uint256 amount);
    event FlashLoanError(string reason);
    event FlashLoanErrorBytes(bytes data);
    
    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 /* referralCode (ignoré) */
    ) external {
        // Check if we have enough balance
        uint256 balance = IERC20(asset).balanceOf(address(this));
        require(balance >= amount, "LooseMockPool: insufficient balance");
        
        // 1) envoie les fonds
        emit FlashLoanInitiated(receiver, asset, amount);
        bool success = IERC20(asset).transfer(receiver, amount);
        require(success, "LooseMockPool: transfer failed");

        // 2) callback arbitragiste (premium = 0 pour simplifier)
        emit FlashLoanCallbackCalled(receiver, asset, amount);
        try IFlashLoanSimpleReceiver(receiver).executeOperation(
            asset,
            amount,
            0,              // premium
            msg.sender,     // initiator (should be the caller of flashLoanSimple)
            params
        ) returns (bool result) {
            require(result, "LooseMockPool: executeOperation returned false");
        } catch Error(string memory reason) {
            emit FlashLoanError(reason);
            revert(string(abi.encodePacked("LooseMockPool: executeOperation failed: ", reason)));
        } catch (bytes memory data) {
            emit FlashLoanErrorBytes(data);
            revert("LooseMockPool: executeOperation failed with no reason");
        }

        // 3) réclame le remboursement de 'amount' uniquement
        emit FlashLoanRepaid(receiver, asset, amount);
        success = IERC20(asset).transferFrom(receiver, address(this), amount);
        require(success, "LooseMockPool: repayment failed");
    }
}
