import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Button, Text, XStack, YStack } from "tamagui";
import {
  Activity as ActivityIcon,
  ArrowLeftRight,
  Home as HomeIcon,
  LogOut,
  Moon,
  Plus,
  ShieldCheck,
  Sun,
  X,
} from "lucide-react-native";
import { useAppearance } from "./AppearanceProvider";
import { Body } from "./components";
import { useBureau } from "./useBureau";
import { Activity, Allocate, Home, Operations, SignIn } from "./screens";

type Tab = "home" | "allocate" | "activity" | "operations";

export function BureauApp() {
  const b = useBureau();
  const { mode, palette: p, toggle } = useAppearance();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>("home");
  const scroll = useRef<ScrollView>(null);
  const role = b.principal?.role;
  const tabs = [
    { id: "home" as const, label: "Home", icon: HomeIcon },
    ...(role !== "employee"
      ? [{ id: "allocate" as const, label: "Allocate", icon: Plus }]
      : []),
    { id: "activity" as const, label: "Activity", icon: ActivityIcon },
    ...(role === "ops"
      ? [{ id: "operations" as const, label: "Ops", icon: ShieldCheck }]
      : []),
  ];

  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [tab, b.message]);

  function signOut() {
    if (b.busy) return;
    b.signOut();
    setTab("home");
  }

  return (
    <SafeAreaView
      testID="app-surface"
      style={{ flex: 1, backgroundColor: p.background }}
      edges={["top", "left", "right"]}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <XStack
          width="100%"
          maxWidth={600}
          alignSelf="center"
          alignItems="center"
          justifyContent="space-between"
          paddingHorizontal={20}
          paddingVertical={14}
          gap={12}
        >
          <XStack gap={10} alignItems="center" flex={1}>
            <YStack
              backgroundColor="$accentSoft"
              width={40}
              height={40}
              borderRadius={13}
              alignItems="center"
              justifyContent="center"
            >
              <ArrowLeftRight size={22} color={p.accentStrong} aria-hidden />
            </YStack>
            <YStack gap={2} flexShrink={1}>
              <Text
                color="$color"
                fontWeight="700"
                fontSize={16}
                letterSpacing={-0.4}
              >
                BureauBridge
              </Text>
              <Body fontSize={11} lineHeight={17}>
                {b.principal
                  ? `${role === "employee" ? "Employee" : role === "ops" ? "Operations" : "Payroll"} · ${b.principal.username}`
                  : "A clearer payroll experience"}
              </Body>
            </YStack>
          </XStack>
          <Button
            testID="appearance-toggle"
            width={44}
            height={44}
            padding={0}
            borderRadius={14}
            backgroundColor="$surface"
            borderColor="$borderColor"
            onPress={toggle}
            accessibilityLabel={
              mode === "light" ? "Use dark appearance" : "Use light appearance"
            }
            aria-label={
              mode === "light" ? "Use dark appearance" : "Use light appearance"
            }
            focusStyle={{ outlineColor: "$accentStrong", outlineWidth: 2 }}
          >
            {mode === "light" ? (
              <Moon size={19} color={p.color} aria-hidden />
            ) : (
              <Sun size={19} color={p.accent} aria-hidden />
            )}
          </Button>
          {!!b.token && (
            <Button
              width={44}
              height={44}
              padding={0}
              borderRadius={14}
              disabled={b.busy}
              backgroundColor="$surface"
              borderColor="$borderColor"
              onPress={signOut}
              accessibilityLabel="Sign out"
              aria-label="Sign out"
              opacity={b.busy ? 0.45 : 1}
              focusStyle={{ outlineColor: "$accentStrong", outlineWidth: 2 }}
            >
              <LogOut size={18} color={p.muted} aria-hidden />
            </Button>
          )}
        </XStack>
        <ScrollView
          ref={scroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{
            width: "100%",
            maxWidth: 600,
            alignSelf: "center",
            paddingHorizontal: 20,
            paddingTop: 12,
            paddingBottom: b.token ? 28 : 28 + insets.bottom,
            gap: 20,
          }}
        >
          {!!b.message && (
            <XStack
              backgroundColor="$warningSurface"
              borderRadius={16}
              padding={14}
              gap={10}
              alignItems="flex-start"
            >
              <Body
                color="$warning"
                flex={1}
                accessibilityLiveRegion="polite"
                aria-live="polite"
              >
                {b.message}
              </Body>
              <Button
                width={44}
                height={44}
                padding={0}
                borderRadius={12}
                chromeless
                accessibilityLabel="Dismiss message"
                aria-label="Dismiss message"
                onPress={b.clearMessage}
              >
                <X size={18} color={p.warning} aria-hidden />
              </Button>
            </XStack>
          )}
          {b.busy && (
            <XStack gap={10} alignItems="center" justifyContent="center">
              <ActivityIndicator color={p.accentStrong} />
              <Body accessibilityLiveRegion="polite" aria-live="polite">
                Working…
              </Body>
            </XStack>
          )}
          {!b.token ? (
            <SignIn bureau={b} />
          ) : tab === "allocate" && role !== "employee" ? (
            <Allocate bureau={b} navigate={setTab} />
          ) : tab === "activity" ? (
            <Activity bureau={b} />
          ) : tab === "operations" && role === "ops" ? (
            <Operations bureau={b} />
          ) : (
            <Home bureau={b} navigate={setTab} />
          )}
        </ScrollView>
        {!!b.token && (
          <YStack
            backgroundColor="$surface"
            borderTopWidth={1}
            borderTopColor="$borderColor"
            paddingBottom={Math.max(insets.bottom, 10)}
            paddingTop={10}
          >
            <XStack
              accessibilityRole="tablist"
              role="tablist"
              width="100%"
              maxWidth={600}
              alignSelf="center"
              gap={6}
              paddingHorizontal={16}
            >
              {tabs.map(({ id, label, icon: Icon }) => (
                <Button
                  key={id}
                  unstyled
                  flex={1}
                  minWidth={0}
                  accessibilityRole="tab"
                  role="tab"
                  accessibilityLabel={`${label} tab`}
                  aria-label={`${label} tab`}
                  accessibilityState={{ selected: tab === id }}
                  aria-selected={tab === id}
                  onPress={() => setTab(id)}
                  minHeight={58}
                  borderRadius={16}
                  backgroundColor={tab === id ? "$accentSoft" : "$surface"}
                  focusStyle={{
                    outlineColor: "$accentStrong",
                    outlineWidth: 2,
                  }}
                  pressStyle={{ opacity: 0.75 }}
                >
                  <YStack
                    alignItems="center"
                    justifyContent="center"
                    gap={5}
                    paddingVertical={9}
                  >
                    <Icon
                      size={20}
                      color={tab === id ? p.accentStrong : p.muted}
                      aria-hidden
                    />
                    <Text
                      fontSize={11}
                      lineHeight={16}
                      fontWeight="600"
                      color={tab === id ? "$accentStrong" : "$muted"}
                    >
                      {label}
                    </Text>
                  </YStack>
                </Button>
              ))}
            </XStack>
          </YStack>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
