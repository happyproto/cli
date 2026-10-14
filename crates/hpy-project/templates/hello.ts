// Answers com.example.hello. Save this file and the next request runs it.
export default function handle(input: { name?: string }, ctx: unknown) {
  return { message: `Hello, ${input.name ?? "world"}!` };
}
