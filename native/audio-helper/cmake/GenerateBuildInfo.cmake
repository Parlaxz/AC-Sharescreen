# GenerateBuildInfo.cmake
# Captures git build provenance and generates BuildInfo.h.
# Can be called from cmake configure time (include()) or build time
# (cmake -P with AHC_SOURCE_DIR and AHC_BINARY_DIR).

# When called from PRE_BUILD, variables are passed via -D
# Use custom variables to avoid CMAKE_SOURCE_DIR confusion in -P mode
if(NOT AHC_SOURCE_DIR)
  set(AHC_SOURCE_DIR "${CMAKE_SOURCE_DIR}")
endif()
if(NOT AHC_BINARY_DIR)
  set(AHC_BINARY_DIR "${CMAKE_BINARY_DIR}")
endif()

set(GIT_COMMIT "unknown")
set(GIT_DIRTY "false")
set(GIT_BRANCH "unknown")

# Try to find git if not already provided
if(NOT GIT_EXECUTABLE)
  find_package(Git QUIET)
  if(Git_FOUND)
    set(GIT_EXECUTABLE "${GIT_EXECUTABLE}")
  endif()
endif()

if(GIT_EXECUTABLE)
  execute_process(
    COMMAND ${GIT_EXECUTABLE} rev-parse --show-toplevel
    WORKING_DIRECTORY ${AHC_SOURCE_DIR}
    OUTPUT_VARIABLE GIT_REPO_ROOT
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
  )

  if(GIT_REPO_ROOT)
    set(GIT_WORK_DIR "${GIT_REPO_ROOT}")
  else()
    set(GIT_WORK_DIR "${AHC_SOURCE_DIR}")
  endif()

  execute_process(
    COMMAND ${GIT_EXECUTABLE} rev-parse HEAD
    WORKING_DIRECTORY ${GIT_WORK_DIR}
    OUTPUT_VARIABLE GIT_COMMIT
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
  )

  execute_process(
    COMMAND ${GIT_EXECUTABLE} status --porcelain
    WORKING_DIRECTORY ${GIT_WORK_DIR}
    OUTPUT_VARIABLE GIT_STATUS_OUTPUT
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
  )
  if(GIT_STATUS_OUTPUT STREQUAL "")
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

# Use pre-passed compiler ID if available (PRE_BUILD passes it from configure time).
# Fall back to detecting here for configure-time invocation.
if(NOT AHC_COMPILER_ID)
  if(MSVC)
    set(COMPILER_ID "MSVC ${CMAKE_CXX_COMPILER_VERSION}")
  elseif(CMAKE_CXX_COMPILER_ID STREQUAL "Clang")
    set(COMPILER_ID "Clang ${CMAKE_CXX_COMPILER_VERSION}")
  elseif(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    set(COMPILER_ID "GCC ${CMAKE_CXX_COMPILER_VERSION}")
  else()
    set(COMPILER_ID "${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}")
  endif()
else()
  set(COMPILER_ID "${AHC_COMPILER_ID}")
endif()

# Build config and architecture
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  set(BUILD_CONFIG "Debug")
elseif(CMAKE_BUILD_TYPE STREQUAL "RelWithDebInfo")
  set(BUILD_CONFIG "RelWithDebInfo")
elseif(CMAKE_BUILD_TYPE STREQUAL "Release")
  set(BUILD_CONFIG "Release")
else()
  set(BUILD_CONFIG "Release")
endif()

if(CMAKE_SIZEOF_VOID_P EQUAL 8)
  set(ARCHITECTURE "x64")
elseif(CMAKE_SIZEOF_VOID_P EQUAL 4)
  set(ARCHITECTURE "x86")
else()
  set(ARCHITECTURE "unknown")
endif()

# Generate the header using file(READ) + string(REPLACE) instead of configure_file
# because configure_file has issues with -P script mode.
file(READ "${AHC_SOURCE_DIR}/src/BuildInfo.h.in" TEMPLATE)

string(REPLACE "@GIT_COMMIT@" "${GIT_COMMIT}" CONTENT "${TEMPLATE}")
string(REPLACE "@GIT_DIRTY@" "${GIT_DIRTY}" CONTENT "${CONTENT}")
string(REPLACE "@GIT_BRANCH@" "${GIT_BRANCH}" CONTENT "${CONTENT}")
string(REPLACE "@BUILD_TIMESTAMP@" "${BUILD_TIMESTAMP}" CONTENT "${CONTENT}")
string(REPLACE "@ARCHITECTURE@" "${ARCHITECTURE}" CONTENT "${CONTENT}")
string(REPLACE "@BUILD_CONFIG@" "${BUILD_CONFIG}" CONTENT "${CONTENT}")
string(REPLACE "@COMPILER_ID@" "${COMPILER_ID}" CONTENT "${CONTENT}")

file(WRITE "${AHC_BINARY_DIR}/generated/BuildInfo.h" "${CONTENT}")
