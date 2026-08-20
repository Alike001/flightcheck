// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @title FlightcheckRegistry
/// @notice Anchors canonical Flightcheck report hashes to their runner address.
/// @dev The registry stores only duplicate-prevention state. Full reports and
///      diagnostic evidence remain offchain and are committed by reportHash.
contract FlightcheckRegistry {
    /// @notice Raised when a caller attempts to anchor an empty commitment.
    error ZeroReportHash();

    /// @notice Raised when the same runner has already anchored the same report.
    error ReportAlreadyAnchored(address runner, bytes32 reportHash);

    /// @notice Emitted once for each unique runner and report-hash pair.
    event ReportAnchored(bytes32 indexed reportHash, address indexed runner, uint64 anchoredAt, uint8 outcomeBitmap);

    mapping(address runner => mapping(bytes32 reportHash => bool anchored)) private _anchored;

    /// @notice Anchors a canonical report hash for the caller.
    /// @param reportHash The keccak256 hash of the canonical Flightcheck payload.
    /// @param outcomeBitmap The deterministically derived compact report outcome.
    function anchorReport(bytes32 reportHash, uint8 outcomeBitmap) external {
        if (reportHash == bytes32(0)) revert ZeroReportHash();
        if (_anchored[msg.sender][reportHash]) {
            revert ReportAlreadyAnchored(msg.sender, reportHash);
        }

        _anchored[msg.sender][reportHash] = true;

        emit ReportAnchored(reportHash, msg.sender, uint64(block.timestamp), outcomeBitmap);
    }

    /// @notice Checks whether a runner has already anchored a report hash.
    function isAnchored(address runner, bytes32 reportHash) external view returns (bool) {
        return _anchored[runner][reportHash];
    }
}
