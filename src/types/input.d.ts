declare module 'input' {
  interface Input {
    text(prompt: string): Promise<string>;
  }
  const input: Input;
  export default input;
}

