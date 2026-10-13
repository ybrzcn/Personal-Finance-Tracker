// Windows release derlemelerinde ek konsol penceresi açılmasını engeller
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    finans_lib::run()
}
