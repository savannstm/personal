# Prints "name seconds" per workload; runs on 2.7 through 4.0 with only the standard library.
def have(*libs)
  libs.each { |l| require l }
  true
rescue LoadError
  false
end

def bench(name)
  GC.start
  t = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  yield
  puts "#{name} #{Process.clock_gettime(Process::CLOCK_MONOTONIC) - t}"
end

def fib(n)
  n < 2 ? n : fib(n - 1) + fib(n - 2)
end

Vec = Struct.new(:x, :y, :z)
Node = Struct.new(:l, :r)
def tree(d)
  d == 0 ? Node.new : Node.new(tree(d - 1), tree(d - 1))
end
def walk(n)
  n.l ? 1 + walk(n.l) + walk(n.r) : 1
end

bench("method_calls") { fib(30) }
bench("while_loop") { i = 0; s = 0; while i < 30_000_000; s = (s + (i & 7) * 3) % 1_000_003; i += 1; end }
bench("blocks_yield") { s = 0; 200.times { (1..50_000).each { |x| s += x } } }
bench("float_math") { x = 0.0; 1.upto(6_000_000) { |i| x += Math.sqrt(i) * 1.0001 / (i + 1.5) } }
bench("struct_objects") { a = Vec.new(0, 0, 0); 1_500_000.times { |i| v = Vec.new(i, i + 1, i + 2); a.x += v.x; a.y += v.y; a.z += v.z } }
bench("gc_binary_trees") { keep = tree(16); 120.times { walk(tree(12)) }; walk(keep) }
bench("array_sort_map") { r = Random.new(1); 12.times { a = Array.new(100_000) { r.rand(1_000_000) }; a.sort.map { |v| v * 2 }.select(&:even?).sum; a.sort_by { |v| -v }; a.uniq.group_by { |v| v % 100 } } }
bench("hash_ops") { 8.times { h = {}; 100_000.times { |i| h["k#{i}"] = i }; s = 0; 100_000.times { |i| s += h["k#{i}"] }; h.each_pair { |_, v| s += v }; h.delete_if { |_, v| v.odd? } } }
bench("symbol_hash_lookup") { h = { a: 1, b: 2, c: 3, d: 4, e: 5 }; s = 0; 3_000_000.times { s += h[:a] + h[:c] + h[:e] } }
bench("string_build") { 20.times { s = +""; 30_000.times { |i| s << "item-" << i.to_s << "," }; s.split(",").map(&:upcase).join(";").sub("ITEM", "x") } }
bench("regexp_scan_gsub") { text = "alpha beta42 gamma@x.org 2024-01-02 delta " * 4000; 25.times { text.scan(/\d+/).size; text.gsub(/(\w+)@(\w+)/, '\2 at \1'); text =~ /(\d{4})-(\d\d)-(\d\d)/ } }
bench("format_integer") { s = 0; 700_000.times { |i| s += format("%08d|%.3f", i, i / 7.0).bytesize + (i * 1234567).to_s(16).size } }
bench("encoding_transcode") { s = "héllo wörld ✓ " * 3000; 150.times { s.encode("UTF-16LE").encode("UTF-8").unpack("U*").pack("U*").valid_encoding? } }
bench("bignum") { f = (1..4000).inject(:*); 60.times { (f * f).to_s.size }; 300.times { |i| 3.pow(20_000 + i) % f } }
bench("exceptions") { 150_000.times { begin; raise ArgumentError, "x"; rescue ArgumentError => e; e.message; end } }
bench("fiber_switch") { f = Fiber.new { loop { Fiber.yield 1 } }; 500_000.times { f.resume } }
bench("threads_mutex") { m = Mutex.new; n = 0; 4.times.map { Thread.new { 400_000.times { m.synchronize { n += 1 } } } }.each(&:join) }
bench("marshal") { d = Array.new(3000) { |i| { id: i, name: "n#{i}", tags: [i, i.to_s, i * 0.5] } }; 40.times { Marshal.load(Marshal.dump(d)) } }
bench("eval_compile") { 6000.times { |i| eval("x = #{i}; [x, x * 2].map { |v| v + 1 }.sum") } }
bench("file_io") { 150.times { File.binwrite("bench.tmp", "line of text\n" * 5000); File.foreach("bench.tmp").count; File.binread("bench.tmp").size }; File.delete("bench.tmp") }
if have("zlib")
  bench("zlib") { r = Random.new(2); d = Array.new(200_000) { "word#{r.rand(500)} " }.join; 6.times { Zlib::Inflate.inflate(Zlib::Deflate.deflate(d, 6)) == d or raise "zlib" } }
end
if have("stringio")
  bench("stringio") { 40.times { io = StringIO.new(+""); 10_000.times { |i| io.puts(i) }; io.rewind; io.each_line.count } }
end
if have("json")
  bench("json") { d = Array.new(3000) { |i| { "id" => i, "name" => "n#{i}", "ok" => i.odd?, "v" => [i, i * 1.5, nil] } }; 40.times { JSON.parse(JSON.generate(d)) } }
end
if have("digest/sha2")
  bench("sha256") { d = "x" * 1_000_000; 100.times { Digest::SHA256.digest(d) } }
end
