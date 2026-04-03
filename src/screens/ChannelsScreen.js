import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS } from '../utils/constants';
import { getChannels, saveChannels } from '../utils/storage';

export default function ChannelsScreen() {
  const [channels, setChannels] = useState([]);
  const [newHandle, setNewHandle] = useState('');

  useFocusEffect(
    useCallback(() => {
      getChannels().then(setChannels);
    }, [])
  );

  const addChannel = async () => {
    const handle = newHandle.trim().replace(/^@/, '');
    if (!handle) return;

    if (channels.some((c) => c.handle.toLowerCase() === handle.toLowerCase())) {
      Alert.alert('Already added', `@${handle} is already in your list.`);
      return;
    }

    const updated = [
      ...channels,
      { handle, name: handle, channelId: null },
    ];
    await saveChannels(updated);
    setChannels(updated);
    setNewHandle('');
  };

  const removeChannel = (handle) => {
    Alert.alert(
      'Remove channel',
      `Remove @${handle} from your list?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const updated = channels.filter((c) => c.handle !== handle);
            await saveChannels(updated);
            setChannels(updated);
          },
        },
      ]
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.addRow}>
        <TextInput
          style={styles.input}
          placeholder="@handle"
          placeholderTextColor={COLORS.textDim}
          value={newHandle}
          onChangeText={setNewHandle}
          onSubmitEditing={addChannel}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={styles.addButton} onPress={addChannel}>
          <Text style={styles.addButtonText}>Add</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={channels}
        keyExtractor={(item) => item.handle}
        renderItem={({ item }) => (
          <View style={styles.channelRow}>
            <Text style={styles.channelHandle}>@{item.handle}</Text>
            <TouchableOpacity onPress={() => removeChannel(item.handle)}>
              <Text style={styles.removeText}>Remove</Text>
            </TouchableOpacity>
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No channels yet. Add one above.</Text>
        }
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  addRow: {
    flexDirection: 'row',
    padding: 16,
    gap: 10,
  },
  input: {
    flex: 1,
    backgroundColor: COLORS.surface,
    color: COLORS.text,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  addButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingHorizontal: 20,
    justifyContent: 'center',
  },
  addButtonText: {
    color: COLORS.bg,
    fontWeight: '700',
    fontSize: 15,
  },
  channelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  channelHandle: {
    color: COLORS.text,
    fontSize: 15,
  },
  removeText: {
    color: COLORS.danger,
    fontSize: 13,
  },
  emptyText: {
    color: COLORS.textDim,
    textAlign: 'center',
    marginTop: 40,
    fontSize: 14,
  },
});
