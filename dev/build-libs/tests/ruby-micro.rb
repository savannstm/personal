def t(name)
  best = 5.times.map { s = Process.clock_gettime(Process::CLOCK_MONOTONIC); yield; Process.clock_gettime(Process::CLOCK_MONOTONIC) - s }.min
  puts "#{name} #{best}"
end
N = 3_000_000
small_sym = { a: 1, b: 2, c: 3, d: 4, e: 5 }
big_sym = (0..40).to_h { |i| [:"k#{i}", i] }.merge(a: 1)
small_int = { 1 => 1, 2 => 2, 3 => 3, 4 => 4, 5 => 5 }
small_str = { "a" => 1, "b" => 2, "c" => 3 }
arr = [1, 2, 3, 4, 5]
t("empty_block") { N.times { } }
t("array_index") { N.times { arr[0]; arr[2]; arr[4] } }
t("sym_small_hash") { N.times { small_sym[:a]; small_sym[:c]; small_sym[:e] } }
t("sym_big_hash") { N.times { big_sym[:a]; big_sym[:k3]; big_sym[:k30] } }
t("int_small_hash") { N.times { small_int[1]; small_int[3]; small_int[5] } }
t("str_small_hash") { N.times { small_str["a"]; small_str["b"]; small_str["c"] } }
t("key?_sym") { N.times { small_sym.key?(:a); small_sym.key?(:c); small_sym.key?(:e) } }
t("integer_plus") { i = 0; N.times { i = i + 1 + 2 + 3 } }
t("ivar_get_set") { o = Object.new; o.instance_variable_set(:@x, 1); N.times { o.instance_variable_get(:@x) } }
t("c_method_call") { s = "abc"; N.times { s.length; s.empty?; s.getbyte(1) } }
t("tls_current_thread") { N.times { Thread.current; Thread.current; Thread.current } }
t("object_alloc") { N.times { Object.new } }
t("frozen_check") { s = "x"; N.times { s.frozen?; s.hash } }
