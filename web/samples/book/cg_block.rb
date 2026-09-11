def f(ary)
  sum = 0
  ary.each { |x| sum += x }
  ary.each { |x| break x if x > 2 }
  ary.each { |x| return x if x < 0 }
  ary.each { |x| next if x == 1 }
  sum
end
def g
  yield 1
end
