import React from "react";
import { Button, Text, XStack, YStack } from "tamagui";
import { CheckCircle2, Clock3, AlertTriangle } from "lucide-react-native";
import { type Allocation, type Status } from "@bureau/contracts";
import { useAppearance } from "./AppearanceProvider";
import { accountName, money, statusLabels, timestamp } from "./presentation";

export function Card({
  children,
  testID,
}: React.PropsWithChildren<{ testID?: string }>) {
  return (
    <YStack
      testID={testID}
      backgroundColor="$surface"
      borderColor="$borderColor"
      borderWidth={1}
      borderRadius={24}
      padding={20}
      gap={16}
    >
      {children}
    </YStack>
  );
}

export function Body(props: React.ComponentProps<typeof Text>) {
  return <Text fontSize={14} lineHeight={22} color="$muted" {...props} />;
}

export function Heading({
  large,
  ...props
}: React.ComponentProps<typeof Text> & { large?: boolean }) {
  return (
    <Text
      accessibilityRole="header"
      role="heading"
      aria-level={large ? 1 : 2}
      fontSize={large ? 32 : 20}
      lineHeight={large ? 39 : 27}
      fontWeight="700"
      letterSpacing={large ? -0.9 : -0.3}
      color="$color"
      {...props}
    />
  );
}

export function Eyebrow(props: React.ComponentProps<typeof Text>) {
  return (
    <Text
      fontSize={11}
      lineHeight={17}
      fontWeight="700"
      letterSpacing={1.3}
      color="$muted"
      {...props}
    />
  );
}

export function ActionButton({
  children,
  onPress,
  disabled,
  secondary,
  icon,
  label,
  testID,
}: {
  children: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  icon?: React.ReactElement;
  label?: string;
  testID?: string;
}) {
  return (
    <Button
      testID={testID}
      accessibilityLabel={label}
      aria-label={label}
      onPress={onPress}
      disabled={disabled}
      icon={icon}
      minHeight={48}
      height="auto"
      paddingVertical={12}
      paddingHorizontal={16}
      borderRadius={16}
      fontSize={14}
      fontWeight="600"
      borderWidth={1}
      borderColor={secondary ? "$borderColor" : "$accent"}
      backgroundColor={secondary ? "$surface" : "$accent"}
      color={secondary ? "$color" : "$onAccent"}
      opacity={disabled ? 0.45 : 1}
      pressStyle={{ opacity: 0.75 }}
      hoverStyle={{ opacity: 0.85 }}
      focusStyle={{ outlineColor: "$accentStrong", outlineWidth: 2 }}
      textProps={{ textAlign: "center" }}
    >
      {children}
    </Button>
  );
}

export function TextAction({
  children,
  onPress,
  disabled,
}: {
  children: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      chromeless
      onPress={onPress}
      disabled={disabled}
      minHeight={44}
      height="auto"
      paddingHorizontal={8}
      paddingVertical={10}
      color="$accentStrong"
      fontSize={13}
      fontWeight="600"
      opacity={disabled ? 0.4 : 1}
      focusStyle={{ outlineColor: "$accentStrong", outlineWidth: 2 }}
    >
      {children}
    </Button>
  );
}

export function StatusBadge({ status }: { status: Status }) {
  const { palette: p } = useAppearance();
  const final = status === "POSTED",
    alert = status === "DECLINED" || status === "NEEDS_REVIEW";
  const colour = final ? p.success : alert ? p.danger : p.warning;
  const Icon = final ? CheckCircle2 : alert ? AlertTriangle : Clock3;
  return (
    <XStack
      alignItems="center"
      alignSelf="flex-start"
      gap={6}
      paddingHorizontal={10}
      paddingVertical={6}
      borderRadius={10}
      backgroundColor={
        final ? p.successSurface : alert ? p.dangerSurface : p.warningSurface
      }
    >
      <Icon size={14} color={colour} aria-hidden />
      <Text
        color={colour}
        fontSize={12}
        lineHeight={18}
        fontWeight="600"
        flexShrink={1}
      >
        {statusLabels[status]}
      </Text>
    </XStack>
  );
}

export function AllocationSummary({ allocation }: { allocation: Allocation }) {
  return (
    <Card>
      <XStack
        alignItems="flex-start"
        justifyContent="space-between"
        gap={12}
        flexWrap="wrap"
      >
        <YStack flex={1} minWidth={110} gap={3}>
          <Text color="$color" fontSize={15} lineHeight={21} fontWeight="600">
            {accountName(allocation.targetAccount)}
          </Text>
          <Body fontSize={12} lineHeight={18}>
            {timestamp(allocation.updatedAt)}
          </Body>
        </YStack>
        <Text color="$color" fontSize={20} lineHeight={27} fontWeight="600">
          {money(allocation.amountMinor)}
        </Text>
      </XStack>
      <StatusBadge status={allocation.status} />
    </Card>
  );
}

export function EmptyState({
  title,
  children,
}: React.PropsWithChildren<{ title: string }>) {
  return (
    <Card>
      <Heading>{title}</Heading>
      <Body>{children}</Body>
    </Card>
  );
}
