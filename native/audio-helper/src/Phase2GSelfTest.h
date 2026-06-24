#ifndef SCREENLINK_PHASE_2G_SELF_TEST_H
#define SCREENLINK_PHASE_2G_SELF_TEST_H

#include <string>

namespace screenlink::audio {

/// Run Phase 2G self-tests. Returns true if all tests pass.
bool RunPhase2GSelfTests();

/// Run Phase 2G self-tests and print results to stderr.
/// @return true if all tests passed.
bool RunAndReportPhase2GSelfTests();

} // namespace screenlink::audio

#endif // SCREENLINK_PHASE_2G_SELF_TEST_H
