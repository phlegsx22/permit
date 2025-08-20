// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IPermit2 {
    struct PermitDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct PermitSingle {
        PermitDetails details;
        address spender;
        uint256 sigDeadline;
    }

    struct PermitBatch {
        PermitDetails[] details;
        address spender;
        uint256 sigDeadline;
    }

    function permit(address owner, PermitSingle memory permitSingle, bytes calldata signature) external;
    function permit(address owner, PermitBatch memory permitBatch, bytes calldata signature) external;
    function transferFrom(address from, address to, uint160 amount, address token) external;
    function allowance(address owner, address token, address spender) external view 
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

contract Permit2Spender is Ownable {
    address public constant PERMIT2_ADDRESS = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    IPermit2 public permit2 = IPermit2(PERMIT2_ADDRESS);

    event PermitSubmitted(address indexed owner, address indexed token, uint160 amount, uint48 expiration);
    event PermitBatchSubmitted(address indexed owner, uint256 tokenCount, uint256 sigDeadline);
    event TokensTransferred(address indexed from, address indexed to, address indexed token, uint160 amount);
    event TokensWithdrawn(address indexed owner, address indexed token, uint256 amount, address indexed to);

    // Constructor sets the deployer as the owner
    constructor() Ownable(msg.sender) {}

    // Submit a single permit
    function submitPermit(address owner, IPermit2.PermitSingle memory permitSingle, bytes calldata signature) external {
        require(permitSingle.spender == address(this), "Spender must be this contract");
        permit2.permit(owner, permitSingle, signature);
        emit PermitSubmitted(
            owner,
            permitSingle.details.token,
            permitSingle.details.amount,
            permitSingle.details.expiration
        );
    }

    // Submit a batch permit
    function submitPermitBatch(address owner, IPermit2.PermitBatch memory permitBatch, bytes calldata signature) external {
        require(permitBatch.spender == address(this), "Spender must be this contract");
        permit2.permit(owner, permitBatch, signature);
        emit PermitBatchSubmitted(owner, permitBatch.details.length, permitBatch.sigDeadline);
    }

    // Transfer a single token
    function transferTokens(address from, address to, uint160 amount, address token) external {
        permit2.transferFrom(from, to, amount, token);
        emit TokensTransferred(from, to, token, amount);
    }

    // Transfer multiple tokens in a batch
    function transferTokensBatch(address from, address to, uint160[] calldata amounts, address[] calldata tokens) external {
        require(amounts.length == tokens.length, "Arrays length mismatch");
        for (uint256 i = 0; i < tokens.length; i++) {
            permit2.transferFrom(from, to, amounts[i], tokens[i]);
            emit TokensTransferred(from, to, tokens[i], amounts[i]);
        }
    }

    // Withdraw tokens from the contract (only owner)
    function withdrawTokens(address token, uint256 amount, address to) external onlyOwner {
        require(to != address(0), "Cannot withdraw to zero address");
        require(amount > 0, "Amount must be greater than zero");

        IERC20 tokenContract = IERC20(token);
        uint256 balance = tokenContract.balanceOf(address(this));
        require(balance >= amount, "Insufficient balance in contract");

        tokenContract.transfer(to, amount);
        emit TokensWithdrawn(msg.sender, token, amount, to);
    }

    // Check allowance for a single token
    function checkAllowance(address owner, address token) 
        external view returns (uint160 amount, uint48 expiration, uint48 nonce) {
        return permit2.allowance(owner, token, address(this));
    }
}