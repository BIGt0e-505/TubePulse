import React, { useRef, useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  runOnJS,
  withSpring,
} from 'react-native-reanimated';
import { COLORS } from '../utils/constants';

const STEP_HEIGHT = 40; // px per unit of change

function SpinnerColumn({ value, min, max, step, onCommit, label }) {
  const offset = useSharedValue(0);

  // Use a ref so the gesture always has the latest commit function
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const doCommit = useCallback((delta) => {
    commitRef.current(delta);
  }, []);

  const gesture = Gesture.Pan()
    .onUpdate((e) => {
      offset.value = e.translationY * 0.25;
    })
    .onEnd((e) => {
      const steps = -Math.round(e.translationY / STEP_HEIGHT);
      offset.value = withSpring(0, { damping: 20, stiffness: 400 });
      if (steps !== 0) runOnJS(doCommit)(steps);
    })
    .minDistance(5);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.column}>
        <Animated.Text style={[styles.digit, animStyle]}>
          {String(value).padStart(2, '0')}
        </Animated.Text>
        <Text style={styles.hint}>{label}</Text>
      </View>
    </GestureDetector>
  );
}

export default function TimeSpinner({ value, onChange }) {
  const [h, m] = value.split(':').map(Number);
  const pad = (n) => String(n).padStart(2, '0');

  const commitHour = useCallback((delta) => {
    const newH = ((h + delta) % 24 + 24) % 24;
    onChange(`${pad(newH)}:${pad(m)}`);
  }, [h, m, onChange]);

  const commitMinute = useCallback((delta) => {
    const totalMins = h * 60 + m + delta * 15;
    const newH = ((Math.floor(totalMins / 60)) % 24 + 24) % 24;
    const newM = ((totalMins % 60) + 60) % 60;
    onChange(`${pad(newH)}:${pad(newM)}`);
  }, [h, m, onChange]);

  return (
    <View style={styles.container}>
      <SpinnerColumn
        value={h}
        min={0}
        max={23}
        step={1}
        onCommit={commitHour}
        label="hr"
      />
      <Text style={styles.colon}>:</Text>
      <SpinnerColumn
        value={m}
        min={0}
        max={45}
        step={15}
        onCommit={commitMinute}
        label="min"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 4,
  },
  column: {
    alignItems: 'center',
    width: 52,
    height: 60,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  digit: {
    color: COLORS.text,
    fontSize: 32,
    fontWeight: '700',
    lineHeight: 40,
  },
  colon: {
    color: COLORS.text,
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 14,
  },
  hint: {
    color: COLORS.textDim,
    fontSize: 10,
    opacity: 0.6,
  },
});
