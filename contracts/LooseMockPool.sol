// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./FlashLoanArbitrage.sol";   // interface IFlashLoanSimpleReceiver

/**
 * @dev  Stub Aave-V3 Pool : ne vérifie rien, ne prélève aucun premium.
 *       Assez pour les tests locaux ; à ne JAMAIS utiliser en production !
 */
contract LooseMockPool {
    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 /* referralCode (ignoré) */
    ) external {
        // 1) envoie les fonds
        IERC20(asset).transfer(receiver, amount);

        // 2) callback arbitragiste (premium = 0 pour simplifier)
        IFlashLoanSimpleReceiver(receiver).executeOperation(
            asset,
            amount,
            0,              // premium
            receiver,
            params
        );

        // 3) réclame le remboursement de 'amount' uniquement
        IERC20(asset).transferFrom(receiver, address(this), amount);
    }
}
