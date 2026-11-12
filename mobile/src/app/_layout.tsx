import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { DarkTheme, ThemeProvider } from "@react-navigation/native";

export default function RootLayout() {
  return (
    <ThemeProvider
      value={{
        ...DarkTheme,
        colors: {
          ...DarkTheme.colors,
          background: "#101012",
          card: "#1c1c1f",
          primary: "#fbbf24",
        },
      }}
    >
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#101012" } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="note/[id]" />
        <Stack.Screen name="search" />
        <Stack.Screen name="config" />
      </Stack>
    </ThemeProvider>
  );
}
