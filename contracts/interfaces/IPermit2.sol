// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IPermit2 {
    function permitTransferFrom(
        address token,
        address from,
        address to,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature
    ) external;
}