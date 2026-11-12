import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import NoteCard from "../components/NoteCard";
import { getDb, searchNotes, tagsForNotes, type NoteRow } from "../lib/db";

/** Busca local FTS5 — instantânea, sem rede (espelho da /api/notes/search). */
export default function SearchScreen() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteRow[]>([]);
  const [tagsByNote, setTagsByNote] = useState<Record<string, string[]>>({});

  const runSearch = useCallback(async (q: string) => {
    const { client } = await getDb();
    const list = await searchNotes(client, q);
    setResults(list);
    setTagsByNote(await tagsForNotes(client, list.map((n) => n.id)));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void runSearch(query), 220);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder="Buscar nas suas notas…"
          placeholderTextColor="#71717a"
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>

      <FlatList
        data={results}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          query.trim().length > 0 ? (
            <Text style={styles.empty}>Nada encontrado para “{query.trim()}”.</Text>
          ) : (
            <Text style={styles.empty}>Digite pra buscar — funciona offline.</Text>
          )
        }
        renderItem={({ item }) => (
          <NoteCard
            note={item}
            tags={tagsByNote[item.id] || []}
            onPress={() => router.push(`/note/${item.id}`)}
            onLongPress={() => router.push(`/note/${item.id}`)}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#101012",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    backgroundColor: "#18181b",
  },
  back: {
    color: "#fafafa",
    fontSize: 30,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#2c2c31",
    borderRadius: 12,
    backgroundColor: "#1c1c1f",
    color: "#fafafa",
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  list: {
    paddingHorizontal: 14,
    paddingBottom: 40,
    paddingTop: 8,
  },
  empty: {
    color: "#71717a",
    textAlign: "center",
    paddingVertical: 50,
  },
});
