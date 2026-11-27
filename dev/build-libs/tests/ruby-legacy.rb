# Prints "name seconds" per workload on Ruby 1.8 and 1.9.
def bench(name)
  GC.start
  start = Time.now
  yield
  puts "#{name} #{Time.now - start}"
end

def fib(n)
  n < 2 ? n : fib(n - 1) + fib(n - 2)
end

Vec = Struct.new(:x, :y, :z)
bench("method_calls") { fib(30) }
bench("while_loop") { i = 0; sum = 0; while i < 3_000_000; sum += i & 7; i += 1; end }
bench("blocks_yield") { sum = 0; 30.times { (1..20_000).each { |i| sum += i } } }
bench("struct_objects") { 150_000.times { |i| Vec.new(i, i + 1, i + 2).x } }
bench("array_sort_map") { srand(1); 8.times { Array.new(30_000) { rand(100_000) }.sort.map { |i| i * 2 } } }
bench("hash_ops") { 4.times { h = {}; 20_000.times { |i| h["k#{i}"] = i }; 20_000.times { |i| h["k#{i}"] } } }
bench("string_build") { 8.times { s = ""; 20_000.times { |i| s << "item-" << i.to_s << "," }; s.split(",").join(";") } }
bench("exceptions") { 30_000.times { begin; raise ArgumentError, "x"; rescue ArgumentError => error; error.message; end } }
