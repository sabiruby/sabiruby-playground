def f
  a = 1
  [1].each { |x| a = x; [2].each { |y| a += y } }
  a
end
