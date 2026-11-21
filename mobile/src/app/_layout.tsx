import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { DarkTheme, ThemeProvider } from "@react-navigation/native";

/**
 * A Home é a âncora do Stack: um router.push disparado por
 * compartilhamento no cold start precisa de uma rota por baixo
 * (senão o Stack nasce sem índice e o push se perde).
 */
export const unstable_settings = {
  initialRouteName: "index",
};

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
        <Stack.Screen name="vault" />
      </Stack>
    </ThemeProvider>
  );
}
