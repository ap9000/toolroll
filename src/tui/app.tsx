/** The terminal UI's placeholder screen (wave 0a spike): a list | detail split, j/k to move, q to quit. */
import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import type { TuiData } from "./data.js";

export interface AppProps {
  readonly data: TuiData;
  /** Called once when the person quits, after Ink is told to exit. */
  readonly onExit?: () => void;
}

export function App({ data, onExit }: AppProps) {
  const { exit } = useApp();
  const items = data.items();
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      onExit?.();
    } else if (input === "j" || key.downArrow) {
      setSelected(index => Math.min(index + 1, Math.max(items.length - 1, 0)));
    } else if (input === "k" || key.upArrow) {
      setSelected(index => Math.max(index - 1, 0));
    }
  });

  const current = items[selected];
  return (
    <Box flexDirection="column">
      <Box>
        <Box flexDirection="column" width="45%" borderStyle="single" paddingX={1}>
          <Text bold>Tasks</Text>
          {items.length === 0 ? <Text dimColor>No tasks</Text> : items.map((item, index) => (
            <Text key={item.id} inverse={index === selected}>
              {index === selected ? "> " : "  "}{item.title}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
          {current === undefined ? <Text dimColor>Nothing selected</Text> : (
            <>
              <Text bold>{current.title}</Text>
              <Text>{current.status}</Text>
              {current.detail.map((line, index) => <Text key={index} dimColor>{line}</Text>)}
            </>
          )}
        </Box>
      </Box>
      <Text dimColor>j/k move · q quit</Text>
    </Box>
  );
}
