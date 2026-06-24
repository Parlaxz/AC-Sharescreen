cmake_minimum_required(VERSION 3.20)
project(screenlink-audio-helper
  VERSION 0.1.0
  LANGUAGES CXX
)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# Require x64 architecture
if(CMAKE_SIZEOF_VOID_P EQUAL 4)
  message(FATAL_ERROR "x64 build required. Re-run cmake with -A x64")
endif()

# Strict warnings
if(MSVC)
  add_compile_options(/W4 /WX /utf-8)
else()
  add_compile_options(-Wall -Wextra -Wpedantic -Werror)
endif()

# Generate build provenance header at configure time
include(cmake/GenerateBuildInfo.cmake)

# Source files
set(SOURCES
  src/main.cpp
  src/WindowsVersion.cpp
  src/AudioCapabilities.cpp
  src/WindowEnumerator.cpp
  src/ProcessResolver.cpp
  src/SourceMapper.cpp
  src/WavWriter.cpp
  src/LoopbackCapture.cpp
  src/PipeTransport.cpp
  src/SyntheticSource.cpp
  src/ServiceSession.cpp
  src/ExclusionPolicy.cpp
  src/AudioSessionMonitor.cpp
  src/ApplicationCaptureSource.cpp
  src/ProcessLoopbackActivator.cpp
  src/EndpointLoopbackSource.cpp
  src/MultiSourceMixer.cpp
  src/FilteredSourcePlanner.cpp
  src/FilteredMonitorController.cpp
  src/Phase2GSelfTest.cpp
)

# Executable
add_executable(${PROJECT_NAME} ${SOURCES})

# Regenerate build provenance at every build (not just configure)
# Uses AHC_SOURCE_DIR/AHC_BINARY_DIR to avoid CMAKE_SOURCE_DIR confusion in -P mode.
# Pass compiler info from configure time since CMAKE_CXX_COMPILER_VERSION is not
# available in cmake -P script mode.
set(AHC_COMPILER_ID "MSVC ${CMAKE_CXX_COMPILER_VERSION}")
add_custom_command(
  TARGET ${PROJECT_NAME} PRE_BUILD
  COMMAND ${CMAKE_COMMAND} -D AHC_SOURCE_DIR="${CMAKE_SOURCE_DIR}"
                           -D AHC_BINARY_DIR="${CMAKE_BINARY_DIR}"
                           -D GIT_EXECUTABLE="${GIT_EXECUTABLE}"
                           -D AHC_COMPILER_ID="${AHC_COMPILER_ID}"
                           -D CMAKE_BUILD_TYPE="${CMAKE_BUILD_TYPE}"
                           -D CMAKE_SIZEOF_VOID_P=${CMAKE_SIZEOF_VOID_P}
                           -P "${CMAKE_SOURCE_DIR}/cmake/GenerateBuildInfo.cmake"
  COMMENT "Regenerating build provenance header..."
)

# Link dwmapi.lib for DwmGetWindowAttribute,
# ole32.lib for COM, avrt.lib for Pro Audio thread priority
target_link_libraries(${PROJECT_NAME} PRIVATE dwmapi ole32 avrt mmdevapi uuid winmm)

# Pass Windows SDK version to C++ code for compile-time checks
if(MSVC AND CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION)
  target_compile_definitions(${PROJECT_NAME} PRIVATE
    SCREENLINK_WIN_SDK_VERSION="${CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION}"
  )
endif()

# Set output directory
set_target_properties(${PROJECT_NAME} PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>"
)

# Include generated build-info header directory
target_include_directories(${PROJECT_NAME} PRIVATE "${CMAKE_BINARY_DIR}/generated")

# Install (not for production installer yet, just for development)
install(TARGETS ${PROJECT_NAME} RUNTIME DESTINATION bin)
