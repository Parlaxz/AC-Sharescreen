/**
 * Shared test helpers for Task 5 quality tests.
 *
 * Radix Select mock — renders interactive DOM elements so real component
 * state callbacks fire. Items are role="option"; clicking calls onValueChange.
 * Also exports selectOption helper for finding and clicking combos/options.
 */
import { vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";

// ─── Radix Select mock ─────────────────────────────────────────────────────
// Call this at the top of test files: vi.mock("@radix-ui/react-select", () => ...)
// but since vi.mock is hoisted, you must duplicate the mock inline in each file.
// This module provides the mock factory function and selectOption helper.

export function createRadixSelectMock() {
  const React = require("react");
  const Ctx = React.createContext<any>(null);

  const Root = ({ children, value, onValueChange }: any) =>
    React.createElement(Ctx.Provider, { value: { value, onValueChange } }, children);

  const Trigger = ({ children, asChild, className, id, ...props }: any) =>
    React.createElement("button", {
      role: "combobox", "aria-haspopup": "listbox", className, id,
      "data-mock-select": "trigger",
    }, children);

  const Value = ({ placeholder, children }: any) => {
    const { value } = React.useContext(Ctx) || {};
    return React.createElement("span", null, value || placeholder || children);
  };

  const Portal = ({ children }: any) => children;
  const Content = ({ children, className, ...props }: any) =>
    React.createElement("div", { role: "listbox", className, ...props }, children);

  const Item = ({ value, children, disabled, className, ...props }: any) => {
    const { onValueChange } = React.useContext(Ctx) || {};
    return React.createElement("div", {
      role: "option", "aria-selected": false, "data-value": value,
      onClick: () => { if (!disabled) onValueChange?.(value); },
      className, style: { cursor: "pointer" },
    }, children);
  };

  const ItemIndicator = () => React.createElement("span", { "data-mock": "item-indicator" });
  const ItemText = ({ children }: any) => React.createElement("span", { "data-mock": "item-text" }, children);
  const Viewport = ({ children }: any) => children;
  const Group = ({ children }: any) => children;
  const Label = ({ children }: any) => React.createElement("div", null, children);
  const Separator = () => React.createElement("hr");
  const Icon = () => React.createElement("span", { "data-mock": "select-icon" });

  return { Root, Trigger, Value, Portal, Content, Item, ItemIndicator, ItemText, Viewport, Group, Label, Separator, Icon };
}

// ─── Motion mock factory ───────────────────────────────────────────────────
export function createMotionMock() {
  const React = require("react");
  const AnimatePresence = ({ children }: any) => React.createElement(React.Fragment, null, children);
  const motion = { div: (props: any) => {
    const { initial, animate, exit, transition, layout, layoutId, ...rest } = props;
    return React.createElement("div", rest);
  }};
  return { default: motion, AnimatePresence, motion };
}

// ─── Select option helper ──────────────────────────────────────────────────
// Finds a combobox whose text matches the label regex, clicks it, then
// finds/clicks the matching option.
export async function selectOption(triggerLabel: RegExp, optionText: string | RegExp) {
  const combos = screen.getAllByRole("combobox");
  const trigger = combos.find(c => triggerLabel.test(c.textContent || ""));
  if (!trigger) throw new Error(`No combobox matching ${triggerLabel} found among ${combos.length} comboboxes`);
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name: optionText });
  fireEvent.click(option);
}
