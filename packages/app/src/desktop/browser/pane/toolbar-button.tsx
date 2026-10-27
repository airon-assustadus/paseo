import { useMemo, type ReactNode } from "react";
import { Text, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function ToolbarButton({
  label,
  children,
  active,
  disabled,
  onPress,
  style,
  testID,
}: {
  label: string;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
  style: (state: { hovered?: boolean; pressed?: boolean }) => StyleProp<ViewStyle>;
  testID?: string;
}) {
  const accessibilityState = useMemo(
    () => ({ disabled: Boolean(disabled), selected: Boolean(active) }),
    [active, disabled],
  );
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        disabled={disabled}
        onPress={onPress}
        style={style}
        testID={testID}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <Text style={styles.toolbarTooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  toolbarTooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));
