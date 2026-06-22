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
)

# Executable
add_executable(${PROJECT_NAME} ${SOURCES})

# Link dwmapi.lib for DwmGetWindowAttribute,
# ole32.lib for COM, avrt.lib for Pro Audio thread priority
target_link_libraries(${PROJECT_NAME} PRIVATE dwmapi ole32 avrt mmdevapi uuid)

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

# Install (not for production installer yet, just for development)
install(TARGETS ${PROJECT_NAME} RUNTIME DESTINATION bin)
