cmake_minimum_required(VERSION 3.20)
project(screenlink-video-enhancer
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
  add_compile_definitions(_CRT_SECURE_NO_WARNINGS NOMINMAX)
else()
  add_compile_options(-Wall -Wextra -Wpedantic -Werror)
endif()

# Generate build provenance header at configure time
include(cmake/GenerateBuildInfo.cmake)

# Source files
set(SOURCES
  src/main.cpp
  src/Protocol.cpp
  src/FrameTransport.cpp
  src/Diagnostics.cpp
  src/SimpleJson.cpp
  src/CapabilityProbe.cpp
  src/NvidiaVfxContext.cpp
)

# NVIDIA VFX integration (disabled by default)
option(SCREENLINK_ENABLE_NVIDIA_VFX "Enable NVIDIA Video Effects SDK" OFF)
set(NVIDIA_VFX_SDK_ROOT "" CACHE PATH "Path to NVIDIA Video Effects SDK root")
set(NVIDIA_VFX_MODEL_DIR "" CACHE PATH "Path to NVIDIA VFX model directory")

# Executable must be defined before target_compile_definitions can reference it
add_executable(${PROJECT_NAME} ${SOURCES})

if(SCREENLINK_ENABLE_NVIDIA_VFX)
  # Resolve SDK root from option, environment, or known path
  if(NOT NVIDIA_VFX_SDK_ROOT)
    if(DEFINED ENV{NVIDIA_VFX_SDK_ROOT})
      set(NVIDIA_VFX_SDK_ROOT "$ENV{NVIDIA_VFX_SDK_ROOT}")
    elseif(EXISTS "C:/Program Files/NVIDIA Corporation/NVIDIA Video Effects")
      set(NVIDIA_VFX_SDK_ROOT "C:/Program Files/NVIDIA Corporation/NVIDIA Video Effects")
    else()
      message(FATAL_ERROR
        "NVIDIA_VFX_SDK_ROOT not set and SDK not found at default path. "
        "Set -DNVIDIA_VFX_SDK_ROOT=<path> or the NVIDIA_VFX_SDK_ROOT environment variable.")
    endif()
  endif()

  message(STATUS "NVIDIA VFX SDK root: ${NVIDIA_VFX_SDK_ROOT}")

  # Include NVIDIA headers
  target_include_directories(${PROJECT_NAME} PRIVATE "${NVIDIA_VFX_SDK_ROOT}/include")

  # Compile definition
  target_compile_definitions(${PROJECT_NAME} PRIVATE SCREENLINK_NVIDIA_VFX_ENABLED)

  # Model directory
  if(NVIDIA_VFX_MODEL_DIR)
    target_compile_definitions(${PROJECT_NAME} PRIVATE
      SCREENLINK_NVIDIA_VFX_MODEL_DIR="${NVIDIA_VFX_MODEL_DIR}")
  elseif(DEFINED ENV{NVIDIA_VFX_MODEL_DIR})
    target_compile_definitions(${PROJECT_NAME} PRIVATE
      SCREENLINK_NVIDIA_VFX_MODEL_DIR="$ENV{NVIDIA_VFX_MODEL_DIR}")
  endif()


endif()

# Regenerate build provenance at every build (not just configure)
# Uses VHC_SOURCE_DIR/VHC_BINARY_DIR to avoid CMAKE_SOURCE_DIR confusion in -P mode.
# Pass compiler info from configure time since CMAKE_CXX_COMPILER_VERSION is not
# available in cmake -P script mode.
set(VHC_COMPILER_ID "MSVC ${CMAKE_CXX_COMPILER_VERSION}")
add_custom_command(
  TARGET ${PROJECT_NAME} PRE_BUILD
  COMMAND ${CMAKE_COMMAND} -D VHC_SOURCE_DIR="${CMAKE_SOURCE_DIR}"
                           -D VHC_BINARY_DIR="${CMAKE_BINARY_DIR}"
                           -D GIT_EXECUTABLE="${GIT_EXECUTABLE}"
                           -D VHC_COMPILER_ID="${VHC_COMPILER_ID}"
                           -D CMAKE_BUILD_TYPE="${CMAKE_BUILD_TYPE}"
                           -D CMAKE_SIZEOF_VOID_P=${CMAKE_SIZEOF_VOID_P}
                           -P "${CMAKE_SOURCE_DIR}/cmake/GenerateBuildInfo.cmake"
  COMMENT "Regenerating build provenance header..."
)

# Link dwmapi.lib for DpiAwareness
target_link_libraries(${PROJECT_NAME} PRIVATE dwmapi)

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
# NVIDIA Video Effects SDK proxy integration.
# These proxy sources load the runtime DLLs dynamically, so no NvVFX.lib is required.
if(SCREENLINK_ENABLE_NVIDIA_VFX)
  target_sources(${PROJECT_NAME} PRIVATE
    "${NVIDIA_VFX_SDK_ROOT}/nvvfx/src/nvVideoEffectsProxy.cpp"
    "${NVIDIA_VFX_SDK_ROOT}/nvvfx/src/nvCVImageProxy.cpp"
  )

  target_include_directories(${PROJECT_NAME} PRIVATE
    "${NVIDIA_VFX_SDK_ROOT}/nvvfx/include"
    "${NVIDIA_VFX_SDK_ROOT}/features/nvvfxvideosuperres/include"
  )
endif()
