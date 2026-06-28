#include "Protocol.h"
#include <unordered_map>
#include <cstring>

namespace screenlink::video {

static const std::unordered_map<std::string_view, Command> kCommandMap = {
    {"hello", Command::kHello},
    {"capabilities", Command::kCapabilities},
    {"configure", Command::kConfigure},
    {"start", Command::kStart},
    {"stop", Command::kStop},
    {"flush", Command::kFlush},
    {"frameAvailable", Command::kFrameAvailable},
    {"frameComplete", Command::kFrameComplete},
    {"stats", Command::kStats},
    {"ping", Command::kPing},
    {"shutdown", Command::kShutdown},
};

Command ParseCommand(std::string_view name) {
    auto it = kCommandMap.find(name);
    return it != kCommandMap.end() ? it->second : Command::kUnknown;
}

std::string_view CommandName(Command cmd) {
    switch (cmd) {
        case Command::kHello: return "hello";
        case Command::kCapabilities: return "capabilities";
        case Command::kConfigure: return "configure";
        case Command::kStart: return "start";
        case Command::kStop: return "stop";
        case Command::kFlush: return "flush";
        case Command::kFrameAvailable: return "frameAvailable";
        case Command::kFrameComplete: return "frameComplete";
        case Command::kStats: return "stats";
        case Command::kPing: return "ping";
        case Command::kShutdown: return "shutdown";
        default: return "unknown";
    }
}

} // namespace screenlink::video
