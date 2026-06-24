# GenerateBuildInfo.cmake
# Captures git build provenance and generates BuildInfo.h at configure time.
# Avoids embedding absolute developer paths in the binary.

find_package(Git QUIET)

set(GIT_COMMIT "unknown")
set(GIT_DIRTY "false")
set(GIT_BRANCH "unknown")

if(Git_FOUND)
  # Find the git repository root (CMAKE_SOURCE_DIR is native/audio-helper,
  # but the repo root is its parent)
  execute_process(
    COMMAND ${GIT_EXECUTABLE} rev-parse --show-toplevel
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE GIT_REPO_ROOT
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
  )

  if(GIT_REPO_ROOT)
    set(GIT_WORK_DIR "${GIT_REPO_ROOT}")
  else()
    set(GIT_WORK_DIR "${CMAKE_SOURCE_DIR}")
  endif()

  execute_process(
    COMMAND ${GIT_EXECUTABLE} rev-parse --short HEAD
    WORKING_DIRECTORY ${GIT_WORK_DIR}
    OUTPUT_VARIABLE GIT_COMMIT
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
  )

  execute_process(
    COMMAND ${GIT_EXECUTABLE} diff --quiet
    WORKING_DIRECTORY ${GIT_WORK_DIR}
    RESULT_VARIABLE GIT_DIRTY_RESULT
    ERROR_QUIET
  )
  if(GIT_DIRTY_RESULT EQUAL 0)
    set(GIT_DIRTY "false")
  else()
    set(GIT_DIRTY "true")
  endif()

  execute_process(
    COMMAND ${GIT_EXECUTABLE} rev-parse --abbrev-ref HEAD
    WORKING_DIRECTORY ${GIT_WORK_DIR}
    OUTPUT_VARIABLE GIT_BRANCH
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
  )
endif()

string(TIMESTAMP BUILD_TIMESTAMP UTC)

# Determine compiler identity
if(MSVC)
  set(COMPILER_ID "MSVC ${CMAKE_CXX_COMPILER_VERSION}")
elseif(CMAKE_CXX_COMPILER_ID STREQUAL "Clang")
  set(COMPILER_ID "Clang ${CMAKE_CXX_COMPILER_VERSION}")
elseif(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
  set(COMPILER_ID "GCC ${CMAKE_CXX_COMPILER_VERSION}")
else()
  set(COMPILER_ID "${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}")
endif()

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  set(BUILD_CONFIG "Debug")
else()
  set(BUILD_CONFIG "Release")
endif()

# Generate the header
configure_file(
  "${CMAKE_SOURCE_DIR}/src/BuildInfo.h.in"
  "${CMAKE_BINARY_DIR}/generated/BuildInfo.h"
  @ONLY
)
